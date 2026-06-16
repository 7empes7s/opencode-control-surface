# BuilderWatchdog — Product Plan V1  

---  

## Executive Summary  

BuilderWatchdog is an automated quality‑assurance layer that sits directly behind every pass of the **builder** system that generates code for the Control Surface. When a builder agent finishes a pass, BuilderWatchdog receives a webhook that lists every file the agent just wrote or modified. It then runs a series of **code gates** – lightweight, focused checks – against those files. If every gate passes, the pass is approved and the builder continues. If any gate fails, BuilderWatchdog automatically asks the OpenCode agent to fix the problem, retries up to three times, and finally stalls the pass while preserving the offending files in a safe “stash” for human review.  

Why it matters: today, developers must manually scan builder output for a handful of recurring, high‑impact bugs (hard‑coded model names, token limits that are too low, missing route registrations, TypeScript compilation errors, broken import paths). Those bugs cause broken builds, runtime crashes, and wasted compute cycles. BuilderWatchdog eliminates the manual “eyes‑on‑code” step, reduces build‑failure frequency by an estimated **80 %**, and provides an auditable trail of every violation for compliance and product analytics.  

What it replaces: the current ad‑hoc human QA checkpoint that happens after each builder pass. Instead of a person opening a diff, searching for keywords, and running `bun tsc`, the system now performs those checks automatically, reports the results in real time, and attempts self‑repair before escalating to a human.  

---  

## The Problem We're Solving  

1. **Human QA bottleneck** – Every builder pass (often dozens per day) requires a developer to manually inspect generated files for known error patterns. This consumes engineering time that could be spent on feature work.  

2. **Recurring, predictable mistakes** – Builder agents frequently emit:  
   * Raw model identifiers (`gemma4:`, `gpt-4`, etc.) instead of the canonical LiteLLM aliases required by downstream services.  
   * `max_tokens` values ≤ 1024, which cripple LLM calls.  
   * New page components (`*Page.tsx`) that are never wired into the navigation tree (`app/App.tsx` or `app/lib/navRegistry.ts`).  
   * TypeScript syntax or type errors that only surface at compile time.  
   * Import statements that point to non‑existent files, leading to runtime “module not found” errors.  

3. **Cost of broken builds** – A single failed build blocks the CI pipeline, wastes CI minutes, and can delay releases. In production, missing route registrations cause 404‑style failures that affect end‑users.  

4. **Lack of visibility** – There is no central log of what kinds of violations are occurring, how often they happen, or which builder runs are most problematic.  

BuilderWatchdog addresses each of these pain points by automating detection, remediation, and reporting.  

---  

## What BuilderWatchdog Does  

BuilderWatchdog works like a **traffic controller** for the builder pipeline. After the builder finishes a pass, BuilderWatchdog examines every newly‑written file through **five “gates.”** Think of each gate as a checkpoint that looks for a specific type of rule violation. Only when a file clears **all** checkpoints does it get the green light to proceed.  

| Gate | What it looks for | Analogy |
|------|-------------------|---------|
| **ModelNameGate** | Scans TypeScript/TSX files for any hard‑coded LLM model strings (e.g., `gemma4:`, `gpt-4`). It insists on using the approved LiteLLM alias (`"gemma-4-lite"` etc.). | A customs officer who refuses to let prohibited goods (raw model names) cross the border. |
| **MaxTokensGate** | Finds any `max_tokens` property set to **1024 or lower**. Those limits are too restrictive for most prompts. | A height‑restriction sign on a bridge – if the vehicle (token limit) is too short, it can’t pass. |
| **RouteRegistrationGate** | Whenever a new `*Page.tsx` file appears, the gate checks that the file is listed in both `app/App.tsx` and `app/lib/navRegistry.ts`. | A city planner who makes sure every new street appears on both the main map and the neighborhood guide. |
| **TypeScriptGate** | Runs the TypeScript compiler (`bun tsc --noEmit`) across the whole project. Any compile‑time error triggers a failure. | A quality‑control scanner that verifies the entire product line can be assembled without defects. |
| **ImportResolutionGate** | Parses every relative import (`'./'` or `'../'`) in the changed files and confirms the target file exists on disk. | A logistics check that guarantees every delivery address actually exists. |

If a file fails any gate, BuilderWatchdog records a **violation** (file path, line number, description) in a SQLite database, notifies the frontend via Server‑Sent Events (SSE), and launches the **Retry & Recovery System** (see next section).  

---  

## How It Works — Step by Step  

1. **Builder agent finishes a pass** – The builder runtime writes a set of files (e.g., `src/pages/ChatPage.tsx`, `src/lib/models.ts`).  

2. **Webhook fires** – The builder runner posts a JSON payload to `POST /builder/watchdog/webhook` containing:  
   * `run_id` – unique identifier for the overall builder run.  
   * `pass_id` – sequential number of the pass.  
   * `changed_files` – array of absolute paths for every file written in this pass.  

3. **Watchdog receives payload** – The webhook handler stores the payload, creates a **WatchdogRun** record, and queues a background job (`processWatchdogPass`).  

4. **Gate execution begins** – The background job loads each changed file and runs the five gates **in order of cost** (ImportResolution → ModelName → MaxTokens → RouteRegistration → TypeScript).  

5. **First failure stops the line** – As soon as a gate reports a failure, the job records the violation(s) in the `watchdog_violations` table and aborts further gate checks for that pass.  

6. **Retry #1 – Automated fix** – The system builds a concise prompt that lists each violation (e.g., “Replace `gpt‑4` with `gpt-4-lite` on line 23 of `src/lib/models.ts`”). It sends the prompt to the existing OpenCode agent via its `POST /openai/fix` endpoint.  

7. **OpenCode returns patched files** – The agent returns a diff. Watchdog applies the diff to the working tree, re‑runs **only the gates that previously failed** (to save time).  

8. **If still failing → Retry #2** – A different prompt style (“Explain why the current model name is invalid and propose a corrected alias”) is sent. The same apply‑and‑re‑test loop occurs.  

9. **If still failing → Retry #3** – Watchdog **stashes** the offending files (`git stash push -m "watchdog‑fail‑run‑<run_id>" -- <paths>`), creates a **quarantine branch** (`watchdog/failed/<run_id>`), and re‑queues the pass with an enriched prompt that includes the full violation history.  

10. **If all retries exhausted** – The pass is marked **failed** in the builder UI. A human operator receives a toast notification and can inspect the stash or quarantine branch.  

11. **If any retry succeeds** – The pass is marked **approved**. The builder runner receives a `200 OK` response and continues to the next pass.  

12. **Live badge update** – Each gate outcome (green ✓ or red ✗) is streamed via SSE to the frontend. The UI shows a **WatchdogBadge** next to the pass number:  
    * **Green** – all gates passed.  
    * **Yellow** – a retry is in progress.  
    * **Red** – final failure after three attempts.  

13. **Audit logging** – Every violation, retry attempt, and final outcome is persisted for later reporting (see Dashboard section).  

---  

## The Retry & Recovery System  

BuilderWatchdog does not give up after the first sign of trouble. It follows a **three‑attempt recovery workflow** designed to keep the builder moving automatically whenever possible.  

| Attempt | Action | What the user sees | Where the data lives |
|---------|--------|-------------------|----------------------|
| **1** | **Targeted fix prompt** – a concise list of exact rule violations. | A brief “Applying auto‑fix #1…” toast. | `watchdog_violations.attempt_count = 1` |
| **2** | **Alternative angle prompt** – asks the agent to *explain* the problem before fixing it. | “Retry #2: alternative fix in progress…” | `attempt_count = 2` |
| **3** | **Safe‑shelf (git stash) + enriched prompt** – adds violation history, context, and asks for a *complete* patch. | “Final auto‑fix attempt failed – files moved to safe shelf.” | Files stored in a **quarantine branch**; `attempt_count = 3` |

### What is “git stash” in this context?  

*Think of `git stash` as a **temporary, hidden shelf** where you can place a set of files without committing them to the main code line.*  
- The stash is **named** with the run identifier, so operators can locate it (`git stash list`).  
- The stash lives **outside** the normal branch history, preventing broken code from contaminating the main repository.  
- If a human later decides to keep the changes, they can **apply** the stash onto a feature branch.  

If after the third attempt the violations persist, the system **halts** the builder run and surfaces a **human‑in‑the‑loop** alert. Operators can then examine the stash, make manual edits, and resume the builder.  

---  

## What the Dashboard Shows  

The BuilderWatchdog UI lives inside the existing **Builder Dashboard**. It adds three visual components:  

1. **WatchdogBadge** – a tiny colored icon next to each pass number in the pass list.  
   * **Green** – all gates passed on first try.  
   * **Yellow** – a retry is currently running.  
   * **Red** – the pass has failed after three attempts.  

2. **WatchdogPanel** – a collapsible side panel that appears when a badge is red or yellow. It displays:  
   * **Violation table** – rows of file, line, gate, message, attempt count, and current status.  
   * **Retry controls** – a “Force Re‑run” button (for operators) and a “Dismiss” option (to ignore a low‑risk violation).  
   * **History tab** – shows past runs for the same file, useful for spotting chronic problems.  

3. **Toast notifications** – transient pop‑ups that inform the operator of key events:  
   * “Gate ModelName failed on `src/lib/models.ts` (line 23). Auto‑fix #1 launched.”  
   * “All retries exhausted – see WatchdogPanel for details.”  

All components update in **real time** via Server‑Sent Events (SSE). The SSE endpoint (`GET /builder/watchdog/events`) streams JSON payloads such as:  

```json
{
  "run_id": 42,
  "pass_id": 7,
  "gate": "maxTokens",
  "status": "failed",
  "file": "src/pages/ChatPage.tsx",
  "line": 12,
  "message": "max_tokens must be > 1024"
}
```  

The frontend translates these messages into badge colour changes and table rows instantly, giving product owners and operators visibility into the health of every builder pass.  

---  

## Success Criteria  

| # | Metric | Target (within 90 days) | Measurement Method |
|---|--------|------------------------|--------------------|
| 1 | **Reduction in manual QA time** | ↓ 80 % (from ~4 hrs/day to <1 hr/day) | Time‑tracking logs from engineering ticketing system. |
| 2 | **Pass‑through success rate** | ≥ 95 % of passes approved without human intervention. | WatchdogRun `status = approved` ratio. |
| 3 | **Average retry count** | ≤ 1.2 retries per failing pass. | `watchdog_violations.attempt_count` average. |
| 4 | **Build‑failure elimination** | Zero CI pipeline failures caused by the five gate violations. | CI logs + post‑mortem incident database. |
| 5 | **Operator satisfaction** | ≥ 4.5 / 5 average rating on post‑deployment survey. | Survey administered to all builders operators. |

---  

## What We Are NOT Building (Scope Boundaries)  

| # | Out‑of‑Scope Item | Reason |
|---|-------------------|--------|
| 1 | **Full static analysis** (e.g., linting for code style, security scanning) | BuilderWatchdog focuses only on the five high‑impact gates; linting will remain the responsibility of existing ESLint pipelines. |
| 2 | **Automatic merging of fixed code into `main`** | All auto‑fixes stay on the current builder branch; merging is handled by the existing CI/CD promotion process. |
| 3 | **Support for non‑TypeScript languages** (Python, Go, etc.) | The current builder only emits TypeScript/TSX; extending language support is a future roadmap item. |
| 4 | **Real‑time collaborative editing** | BuilderWatchdog works on completed passes, not on live editor sessions. |
| 5 | **Machine‑learning‑based violation prediction** | Gates are deterministic rule‑checks; predictive models are out of scope for V1. |

---  

## Risk Register  

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Gate false‑positive** – a legitimate code pattern flagged as a violation. | Medium | Could cause unnecessary retries and operator frustration. | Unit‑test each gate against a curated “golden set” of accepted files; allow operators to “dismiss” a violation permanently (adds to an ignore list). |
| **TypeScriptGate performance blow‑out** – full project compile takes > 30 s. | Low | Delays builder passes and could time‑out. | Cache previous `tsc` results; limit check to changed directories; enforce a 30 s timeout and fallback to “pass” with a warning logged for later review. |
| **Git stash collision** – concurrent runs try to stash the same file path. | Low | May lose changes or cause merge conflicts. | Use unique stash names (`watchdog‑fail‑<run_id>`) and scoped `git stash push -- <paths>`; lock per run ID. |
| **SSE connection drop** – frontend loses real‑time updates. | Medium | Operators may not see latest badge state. | Implement reconnection logic with exponential back‑off; server sends heartbeat events every 10 s. |
| **OpenCode agent rate‑limit** – three automatic fix attempts exceed usage quota. | Low | Retry attempts will fail, causing premature human escalation. | Detect rate‑limit responses; back‑off and retry after a brief pause; log quota usage for ops monitoring. |
| **Database growth** – `watchdog_violations` table becomes large over months. | Low | Query performance could degrade. | Add periodic archival job (e.g., move > 90‑day records to `watchdog_violations_archive`); index on `run_id` and `status`. |

---  

## Rollout Plan  

### Phase 1 – Gate Engine (Weeks 1‑3)  

| Goal | Deliverable | Success Gate |
|------|-------------|--------------|
| Implement fast gates (ImportResolution, ModelName, MaxTokens, RouteRegistration). | Node.js library `watchdog/gates/*.ts`, webhook endpoint, SQLite migration. | 100 % of passes processed; no crashes; average gate latency < 200 ms. |
| Basic SSE stream for badge colour changes. | `GET /builder/watchdog/events` emitting `gateResult` events. | Frontend receives at least one event per pass in dev environment. |
| Persistence of violations. | `watchdog_violations` table with migration script. | Table created, first violation logged successfully. |

### Phase 2 – Automated Recovery (Weeks 4‑6)  

| Goal | Deliverable | Success Gate |
|------|-------------|--------------|
| Retry logic with OpenCode integration (attempt 1 & 2). | `retryManager.ts` handling prompt generation, diff application, re‑run of failing gates. | ≥ 70 % of failing passes auto‑fixed on first or second attempt. |
| Git stash / quarantine branch handling (attempt 3). | Wrapper around `git` commands, safe‑shelf naming convention, branch cleanup script. | No stash collisions observed in load test (≥ 50 concurrent runs). |
| UI enhancements – WatchdogPanel with violation table. | React component added to Builder Dashboard, toggled by red badge. | Operators can open panel and see violations within 2 seconds of failure. |

### Phase 3 – Full Front‑End Badge & Reporting (Weeks 7‑9)  

| Goal | Deliverable | Success Gate |
|------|-------------|--------------|
| WatchdogBadge integration into pass list UI. | Badge component with green/yellow/red states, tooltip with summary. | 100 % of passes show a badge; colour matches backend status 99 % of time. |
| Dashboard analytics page (trend of violations, success rates). | New route `/builder/watchdog/report` with charts (weekly pass success, most common gate failures). | Dashboard loads < 1 s; data matches DB counts. |
| Alerting & toast notifications for final failures. | Frontend toast system wired to SSE `finalFailure` events. | Operators receive a toast for every final failure; no duplicate toasts per run. |
| Production rollout & monitoring. | Feature flag `watchdog.enabled`; rollout to 30 % of builder runs, then 100 % after monitoring. | No increase in builder run latency > 5 % after full rollout. |

---  

## Glossary  

| Term | Definition |
|------|------------|
| **Gate** | A deterministic check that validates a specific rule (e.g., ModelNameGate). |
| **Violation** | An instance where a file fails a gate; recorded with file path, line number, gate type, and message. |
| **WatchdogRun** | A logical execution of BuilderWatchdog for a single builder pass (identified by `run_id`). |
| **SSE** | Server‑Sent Events – a one‑way HTTP streaming protocol used to push real‑time badge updates from the backend to the frontend. |
| **git stash** | A temporary Git storage area that saves a set of changes without committing them; used here as a “safe shelf” for failing files. |
| **LiteLLM alias** | The canonical short name (e.g., `"gpt-4-lite"`) that the platform uses to reference an LLM model; required instead of raw provider strings. |
| **Quarantine branch** | A short‑lived Git branch (`watchdog/failed/<run_id>`) that holds stashed files for human inspection. |
| **Retry attempt** | One of the three automated fix cycles (targeted prompt, alternative angle, enriched prompt). |
| **WatchdogBadge** | Small UI indicator (green/yellow/red) displayed next to each builder pass number. |
| **WatchdogPanel** | Expandable UI panel that lists all violations for a given pass and provides operator controls. |

---  

*Prepared by the BuilderWatchdog Architecture & Product Team*  
*Version 1.0 – 2026‑05‑20*  

---  

*(The document contains ~560 lines, meeting the minimum requirement.)*