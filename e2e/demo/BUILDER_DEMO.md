# Builder Demo — "a real bug, caught and fixed" (SPEC 7 / ULTRAPLAN P1.1 / SHOWCASE Phase 3)

**Created**: 2026-07-05. **Companion to**: `SHOWCASE_DEMO_SCRIPT.md` (this scenario is appended there as the
"Builder proof beat"), `SHOWCASE_SPINE_PLAN.md` Phase 3, `e2e/demo/REHEARSAL_REPORT.md` (SPEC 6, same
honesty format).

This is the presenter script for the staged Builder scenario: **start a workflow → a real pass runs →
a real validation command catches a real, planted bug → the failure is diagnosed and traced, not hidden
→ apply the fix (deterministic or agentic) → re-run → green.** Every mechanism below is the same code
path production Builder workflows use — only the *project* (a tiny throwaway calculator) and the *bug*
(planted on purpose) are staged. Steps marked **[DEMO DATA]** are staged/seeded; steps marked
**[LIVE MECHANISM]** are the real, unmodified pipeline running on the live `:3000` service.

---

## Stage / reset / fix — one command each way

```bash
cd /opt/opencode-control-surface

# Stage (idempotent): copies e2e/demo/builder-demo-template/ to
# /opt/provisioned/builder-showcase-demo, commits the GREEN baseline, plants
# the bug as a second real commit, registers the project + a `once`-mode
# workflow (existing provision + workflow-create API, never a raw allowlist edit).
./e2e/demo/stage-builder-demo.sh

# Deterministic fix beat (no agentic model required): restores the known-good
# src/discount.ts as a third real commit.
./e2e/demo/stage-builder-demo.sh --fix

# Back to the staged bug state + this demo's workflow runs cleared (deletes only
# the ONE workflow this script itself registered, looked up by exact name +
# project root — never a broad DELETE).
./e2e/demo/stage-builder-demo.sh --reset
```

Each command prints the current project/workflow id and exactly what to click next. All three were run
repeatedly during this task (see Verification below) and are idempotent — re-running `stage` twice does
not create duplicate commits or duplicate workflows; `--fix` run twice is a no-op the second time;
`--reset` always returns to the same tagged bug commit (`git tag demo-bug-state`).

## The bug (real, not `exit 1` theater)

`e2e/demo/builder-demo-template/` is a tiny, real Bun+TypeScript library: a checkout-total calculator
(`src/discount.ts`, `src/tax.ts`, `src/checkout.ts`) with 9 `bun test` cases (`tests/checkout.test.ts`).
The planted bug is a sign flip in `applyDiscount()`:

```diff
- return Math.round((subtotalCents * (100 - discountPercent)) / 100);
+ return Math.round((subtotalCents * (100 + discountPercent)) / 100);
```

A "10% discount" *increases* the price instead of reducing it. `bun test` genuinely fails (3 of 9 cases)
in the bug state and genuinely passes (9 of 9) once fixed — verified directly, not inferred:

```
# bug state:  6 pass / 3 fail  (Expected: 900, Received: 1100 — the exact wrong-sign symptom)
# fixed state: 9 pass / 0 fail
```

## Click-by-click

1. Open `/builder` (or start via API — see the script's printed `curl` line). Find project
   **"Showcase Builder Demo (staged)"** → workflow **"Showcase Builder Demo — staged bug pass (once)"**.
   The project card shows its real root, `/opt/provisioned/builder-showcase-demo` — **[DEMO DATA]**,
   clearly labeled per G3, never confused with a real customer project.
2. Click **Start**. **[LIVE MECHANISM]**: this calls `POST /api/builder/workflows/:id/start`
   (`server/api/builder.ts:626`) → `startWorkflowRun()` (`server/builder/runner.ts:1746`), which acquires
   a real per-project lock, spawns a real tmux session running an agentic CLI (`opencode`), and creates
   real `builder_runs`/`builder_passes` rows — the identical code path any real project's workflow uses.
3. **You will see**: the pass runs (agent picks a model from the dynamically-resolved, verified free
   model roster — never a hardcoded id, see "Model selection" below), then a **validation step runs
   `bun test` in the real repo** (`server/builder/runner.ts`'s `runValidationCommands` →
   `runInternalValidation`, a real `spawnSync("/bin/bash", ["-c", "bun test"], { cwd: projectRoot })`).
   Because the bug is real, this **genuinely fails** — same as running it in a terminal.
4. **Proof it's real** — expand the run's validation row: the `outputTail` is bun's own real assertion
   failure text (`Expected: 900\nReceived: 1100`), not a canned string. The pass is downgraded to
   `failureClass: "validation-failed"` and the run finishes `status: "failed"`.
5. **Apply the fix**: either run `./e2e/demo/stage-builder-demo.sh --fix` (deterministic, a real git
   commit) or click **Start** again and let the agentic pass attempt the fix itself — **report which one
   actually happened, honestly** (see "What actually happened on this run" below; both paths were
   exercised live during this task).
6. **Re-run**: click **Start** again. **You will see**: `bun test` now passes, the run finishes
   `status: "success"`.

## What actually happened on this run (both outcomes exercised live, reported honestly)

**Failure pass** — model `openrouter/openai/gpt-oss-120b:free` via `opencode`, run
`br_4ee2df14-e4cc-45b3-b5b2-245fee215e2f`, ~85 seconds. The model correctly diagnosed the bug in its own
`passNote` ("applyDiscount returns too high values... next step is to correct the discount and tax
calculations") **without being asked to fix anything** (Phase 1 of `PLAN.md` is deliberately
diagnosis-only, so the *validation step* — not the agent — is what demonstrates the real failure,
deterministically, regardless of model quality). `bun test` failed for real
(`bv_f70ecc1d-6774-44ad-86e7-023ae9f170c1`, kind `command`, status `failed`).

**Fix + green pass**: this run used `stage-builder-demo.sh --fix` (the deterministic path), not an
agentic fix — **honest reporting, not the ideal outcome**: on a *second* live attempt, giving the agentic
pipeline a chance to fix it itself (workflow re-run with `Phase 2` now reachable), the first two models in
the verified group (`opencode/deepseek-v4-flash-free`, `opencode/nemotron-3-ultra-free`'s *sibling*
`opencode/deepseek-v4-flash-free` and then `opencode/nemotron-3-ultra-free` itself) each hit the pass
timeout before producing output; the run's built-in fallback (`canContinueAfterTimeout` in
`server/builder/runner.ts`) automatically retried with the next model in the group each time — real
resilience, not scripted — and **pass 3, `opencode/nemotron-3-ultra-free`, finished quickly and the run
went green** (run `br_ab0dc7eb-f2df-4843-bdbd-860702888a90`, `status: "success"`, 3 passes, ~8 minutes
total). By that point `--fix` had already been applied from the prior step, so pass 3 didn't need to edit
anything — `bun test` was already real-green when it ran. **This means the specific "agentic pass
genuinely fixes the planted bug live" outcome was not directly observed this session** — what *was*
observed live is the framework's real multi-model fallback-on-timeout mechanism, and a real green run.
A presenter re-running this scenario may well see the agentic pass do the actual fix; say whichever
happens, honestly, out loud.

## Model selection — never hardcoded

The workflow's `agentOrder` is `["opencode:group:agentic-heavy"]` — a group token
(`server/builder/store.ts` `expandAgentOrderGroups()`), not a specific model id. At save time this
expands to whatever `/var/lib/control-surface/agentic-models.json` currently reports as *verified* (at
the time of this task: `openrouter/openai/gpt-oss-120b:free`, `opencode/deepseek-v4-flash-free`,
`opencode/nemotron-3-ultra-free`) — the same dynamic roster resolution every other Builder workflow uses,
re-resolved automatically as the roster changes. `passTimeoutSeconds`/`stallTimeoutSeconds` are set to
240s (not the system default 1500s/2700s) — **an honest operational tuning, not a gate widened to make
something pass**: 2 of the 3 verified models are, empirically (observed live this session and in this
workflow's own run history), prone to stalling for 10–25 minutes on this trivial repo; 240s keeps a
worst-case demo (2 timeouts + 1 quick success) to about 9 minutes instead of up to 75.

## Evidence chain (ids + API tails)

| What | Value |
|---|---|
| Project | `project:/opt/provisioned/builder-showcase-demo` (`Showcase Builder Demo (staged)`) |
| Workflow (used for this drive; later reset/re-created) | `bw_2e769e32-7fdd-412c-84ef-f61dd44b24c6` |
| Workflow (final, ready-to-click state left behind) | `bw_5c757d40-8c95-495c-b16a-97b6cca7a8a3` |
| Failure run | `br_4ee2df14-e4cc-45b3-b5b2-245fee215e2f` — `status: "failed"`, `error: "Validation failed: bun test"` |
| Failure pass | `bp_b47e21a1-8fd0-4718-8358-b6f66bf88969` — `agent: opencode`, `model: openrouter/openai/gpt-oss-120b:free`, `failureClass: "validation-failed"` |
| Failure validation (real bun test output) | `bv_f70ecc1d-6774-44ad-86e7-023ae9f170c1` — `kind: "command"`, `command: "bun test"`, `status: "failed"`, `outputTail` contains `Expected: 900 / Received: 1100` |
| Green run | `br_ab0dc7eb-f2df-4843-bdbd-860702888a90` — `status: "success"`, 3 passes (2 timeouts, 1 success) |
| Green validations | all 3 passes' `bun test` command validations `status: "success"` |
| `--fix` commit (this session) | `1a68901bb3d57230b974e46c3d4983f93579684a` — "Fix: revert discount sign flip (deterministic demo fix)" |
| `demo-bug-state` git tag | tags the planted-bug commit for `--reset` |

```bash
# Real curl tail proving the failure evidence (redacted token):
TOKEN=$(grep -E '^OPERATOR_TOKEN=' /etc/control-surface/secrets.env | cut -d= -f2-)
curl -s -H "x-operator-token: $TOKEN" \
  http://127.0.0.1:3000/api/builder/runs/br_4ee2df14-e4cc-45b3-b5b2-245fee215e2f \
  | jq '.data.run.status, .data.run.error, .data.passes[0].failureClass'
# "failed"
# "Validation failed: bun test"
# "validation-failed"
```

## The "diagnosis queued" claim — honest status, not fabricated

The task's design intent is: a validation failure should queue a reasoner diagnosis
(`queueDiagnosis`, `server/reasoner/agent.ts`) and match the built-in `validation-failed` → "Surface to
operator" playbook (`server/reasoner/playbooks.ts`), the same way build failures already reach the
Insights Inbox (`server/insights/scanners/build.ts`, `mapReasonerBuildFindings()`). **Driving this
scenario live surfaced that this did not actually happen** — investigated, root-caused, and fixed (see
"Backend fix" below). Because the live `:3000` service was still running the pre-fix binary during this
session (restarting it is the orchestrator's job, not this task's), `reasoner_jobs` is empty for
`bp_b47e21a1...` on this specific run — **that absence is itself the confirming evidence of the bug**,
not a demo failure. The fix is verified by an automated regression test (see Verification), and by the
*sibling* mechanism it reuses: the two `pass-timeout` failures in the green run **did** correctly queue
`reasoner_jobs` rows (`rq_a5cdc662-8444-4e8e-844a-b72be873e027`, `rq_77b1a764-3574-4247-a7fe-3f6df0be4deb`)
via the pre-existing (unrelated to this fix) exit-code-based trigger — proof the reasoner pipeline itself
is alive and running real LLM diagnosis calls on this host. **Recommendation**: re-drive this exact
scenario once after the orchestrator restarts the service with this fix applied, to capture the
post-restart live `reasoner_jobs`/Insights-Inbox evidence end-to-end.

## Backend fix made while driving this scenario (justified, documented)

**`server/builder/runner.ts`, the "Correct the pass status to reflect validation" block** (originally
lines 2437–2446, now ~2437–2460): when an agent pass exits `0` but the project's own validation command
fails afterward, the pass is downgraded to `failureClass: "validation-failed"` / `"build-failed"` — but
this downgrade happens *after* the function's one `queueDiagnosis()` call site, which only fires when
`passStatus === "failed"` at that earlier point (agent-exit-code-based, before validations even run). Net
effect: **a validation-only failure could never be diagnosed** — `mapReasonerBuildFindings()`
(`server/insights/scanners/build.ts`) reads `reasoner_diagnoses`, not `builder_passes`, so these real
failures never reached the Insights Inbox, and the built-in `validation-failed` playbook could never be
matched for them. Fixed by also calling `queueDiagnosis()` in the downgrade block. This is a real gap
affecting **every** Builder workflow with a validation profile, not a demo-only issue — discovered because
this task needed the exact "validation catches a bug → diagnosis → insight → playbook" chain to be real,
not because of anything demo-specific.

**Test added**: `server/builder/runner.test.ts`, new `describe("reconcileRunStatus — validation-only
failure")` — drives the real `reconcileRunStatus()` reconciliation path (no mocked `spawnSync`/tmux, same
idiom as this codebase's other integration tests) with a deterministically-failing validation command,
and asserts a `reasoner_jobs` row is queued. Confirmed to fail without the fix and pass with it (verified
via `git stash` before finalizing).

## Two more structural bugs found while driving this — reported, not fixed (out of surgical scope)

1. **`server/builder/runner.ts:2390`** — `const passResult = readPassResult(runId, passSeq);` uses the
   legacy 2-argument call form, which resolves only the flat legacy run-directory path
   (`/var/lib/control-surface/builder-runs/<runId>/PASS_RESULT.json`). Every *other* call to
   `readPassResult` in this same file (e.g. line 2277, same function) correctly uses the 4-argument
   tenant-aware form (`readPassResult(run.tenantId, projectId, runId, passSeq)`). Since any real project
   (one with a `builder_projects` row, i.e. essentially all of them) writes to the tenant-aware nested
   path, this call **silently returns `null`** — so `passResultStatus` is always read as unset, breaking
   `canContinueFromResult`/"plan complete" detection for continuation decisions across the whole system.
   Observed live in this task: the failure pass's own `PASS_RESULT.json` correctly said
   `status: "incomplete"` with `nextInstruction` pointing at Phase 2, but the run stopped after one pass
   anyway. **Not fixed here** — it's a deep, wide-blast-radius change to core continuation logic
   affecting every multi-pass workflow on this host, not a one-line addition like the fix above; it
   deserves its own dedicated review rather than a rushed fix bundled into a demo-staging task.
2. **`server/reasoner/agent.ts`'s `runDiagnosisJob`** — observed a `reasoner_jobs` row
   (`rq_77b1a764-3574-4247-a7fe-3f6df0be4deb`) transition to `status: "done"` with no corresponding row
   ever appearing in `reasoner_diagnoses` for that pass/run. The `done` status is only supposed to be set
   after a successful `upsertDiagnosis()` + `clusterDiagnosis()` call inside the same try block, so this
   looks like a real (if rare) false-positive "done" — investigated but not root-caused given this task's
   time budget; flagging for separate investigation rather than guessing at a fix.

## `/builder` + `/agent-team` narration check (walked both pages, both states, live)

Walked `/builder` and `/agent-team` on the live `:3000` service against this exact scenario (failing and
fixed states) via a scratch Playwright session (per `e2e/demo/REHEARSAL_REPORT.md` precedent — not a
committed deliverable).

**Fixed — `app/globals.css`** (both confirmed live via `bun run check` rebuild + before/after screenshot):

- **`app/globals.css:2839` (`.data-row-detail-grid strong`)** — added `white-space: normal;`. Root cause:
  `.workflows-table td` (`app/globals.css:4316`) sets `white-space: nowrap` on every `<td>` in the Builder
  page's workflow table, including the expanded detail row's `<td colSpan={12}>`
  (`app/routes/BuilderPage.tsx:3366`); `overflow-wrap: anywhere` (already present) does not override an
  *inherited* `nowrap` — they're independent properties. Effect: expanding any workflow row's detail panel
  rendered long values (workflow/run ids, full paths) as one unbroken line that visually overflowed
  sideways past its 182px grid cell into the next cell's label/value text (confirmed via computed-style
  inspection: the cell's layout box stayed 182px wide while the rendered text spilled past it, since the
  cell wrapper is `overflow: visible`). This affected every workflow's expanded row, not just this demo's.
- **`app/globals.css:2830` (`.data-row-detail-grid span`)** → scoped to
  `.data-row-detail-grid > div > span`. Root cause: the bare `span` selector also matched the *value's*
  nested `<span className="mono">` (used for workflow id / run id / paths), wrongly applying the label's
  `text-transform: uppercase` styling to real values — e.g. our workflow id rendered as
  `BW_2E769E32-7FDD-412C-84EF-F61DD44B24C6` instead of the real, lowercase
  `bw_2e769e32-7fdd-412c-84ef-f61dd44b24c6`. Cosmetic but misleading for anyone copying an id from the
  screen.

**Reported, not fixed (structural, needs a backend/API change, not a page-only fix)**:

- **`app/routes/BuilderPage.tsx:3455`** — the workflows table's "pass" column renders
  `run.currentPassId ?? "-"`. `server/builder/runner.ts` sets `currentPassId: null` on *every*
  finalization path (success, failure, blocked, stalled, paused) as part of properly closing out a run —
  so for any run that has actually finished, this column can only ever show `"-"`, even though real passes
  ran (confirmed: our finished runs' rows all show `-` here despite having 1–3 real passes each). Not a
  lie exactly (it never claims a false id), but a dead column for the single most common case (a
  completed run). A real fix needs the runs list to expose e.g. `lastPassId`/`passCount` per run — an API
  shape change, reported rather than built under this task's surgical-fix scope.

**`/agent-team`**: this page is a project-wide "self-improvement team" roster (orchestrator/plan/build/
audit/oversee/cheap/genius-max agents, job queue stats, self-correction ship/rollback summary) — it is not
workflow-specific, so there is no per-workflow content on this page tied to our specific demo scenario to
check. No stumbles found; no console/page errors either state. Presenter framing: use `/agent-team` to
show the *broader* self-improving system, and `/builder` for this specific scenario's evidence.

## Honest staged-vs-live breakdown (G3)

- **[DEMO DATA]**: the project name (`Showcase Builder Demo (staged)`), the repo itself, and the planted
  bug — clearly labeled, never confused with a real customer project.
- **[LIVE MECHANISM]**: workflow start/stop/run reconciliation, the tmux-isolated agentic pass, the real
  `bun test` validation command, the pass/run status classification, the reasoner diagnosis queue and its
  real LLM calls, the playbook table, git history in the demo repo (real commits, real tags, real
  `git log`/`git diff`) — identical code paths to any real Builder project on this host.

## Verification

- `bun run check` — clean (typecheck + vite build), confirmed after all fixes.
- `DASHBOARD_DB=1 bun test` — **956 pass / 0 fail** across 137 files (see tail below), run after all
  changes in this task. The task spec's stated baseline was 946 pass / 0 fail; this task added exactly
  one new test (`server/builder/runner.test.ts`'s `reconcileRunStatus — validation-only failure`
  describe block). The remaining +9 over 946 was not independently re-verified against a pre-task
  checkout in this session — reported as observed (956, 0 fail, same file/test count sanity as expected
  plus this task's 1 addition) rather than reconciled to the exact 946 figure.
- `bash e2e/fresh-host/gate.sh` — **PASS**: API probe CRASH=0, ERROR-5xx=0, no unexpected LEAK; UI audit
  41/41 pass, 0 fail, 0 unexpected (see tail below). Run because `app/globals.css` and
  `server/builder/runner.ts` both changed.

```
 956 pass
 0 fail
 8515 expect() calls
Ran 956 tests across 137 files. [258.69s]
```

```
[gate.sh] === summary ===
[gate.sh] API probe: CRASH=0 ERROR-5xx=0 unexpected-LEAK=no
[gate.sh] UI audit: total=41 pass=41 fail=0 unexpected=0
[gate.sh] GATE: PASS
```

## Live-service state left behind

- Workflow `bw_5aac499c-d4e8-4885-8293-f649ee99dd7d` — `status: "ready"`, `lastRunId: null`, no queued or
  running run (this is the id left behind after a final full clean-slate `stage → stage → --fix → --fix →
  --reset` cycle re-run to confirm idempotency after this task's last script edit — the earlier ids in
  the evidence table above, e.g. `bw_2e769e32-...`, were from the actual scenario drive and were later
  superseded by this final reset; both are real, just from different points in the same session).
  `/opt/provisioned/builder-showcase-demo` reset to the tagged bug state (2 commits: green baseline,
  planted bug), `bun test` genuinely 6 pass / 3 fail. No orphaned tmux sessions (checked
  `tmux -L tib-mimule list-sessions` — only the pre-existing, unrelated `init` session remains).
