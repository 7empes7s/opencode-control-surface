#!/usr/bin/env python3
"""
BuilderWatchdog Planning Script
Runs 6 specialist passes via LiteLLM then synthesizes WATCHDOG_PLAN_V1.md and WATCHDOG_PLAN_V2.md
"""

import os
import sys
import time
import requests

LITELLM_URL = "http://127.0.0.1:4000"
MODEL = "editorial-cloud-heavy"
MAX_TOKENS = 6000
TIMEOUT = 300
OUTPUT_DIR = "/opt/opencode-control-surface/plans/watchdog"

CODEBASE_CONTEXT = """
## Codebase Context: OpenCode Control Surface

The control surface is a Bun + Hono server with a React frontend (wouter routing), SQLite DB
(accessed via `getDashboardDb()` from `server/db/dashboard.ts`), and a builder system
that runs OpenCode agents to implement features.

### Key patterns observed:

**DB pattern** (from dashboard.ts):
- `getDashboardDb()` returns `Database | null`
- Migrations use inline `CREATE TABLE IF NOT EXISTS` in `migrateDashboardDb()`
- Schema version tracked in `schema_version` table
- PRAGMA: WAL mode, busy_timeout 5000ms

**SSE broadcast pattern** (from brainstorm-stream.ts):
- In-memory Map of listeners keyed by `"tenantId:sessionId"`
- `broadcastXxxEvent(tenantId, sessionId, type, data)` pattern
- `ReadableStream` with `text/event-stream` content-type
- Frontend subscribes via EventSource

**LiteLLM call pattern** (from brainstorm-orchestrator.ts):
- `fetch(litellmUrl + '/v1/chat/completions', { method: "POST", ... })`
- Uses env `LITELLM_URL` (default `http://127.0.0.1:4000`) and `LITELLM_MASTER_KEY`
- Model: logical alias names like `editorial-cloud-heavy`

**Hono route pattern** (from brainstorm-actions.ts):
- `import { Hono } from 'hono'`
- Auth via `checkToken(authToken)` from `./actions.ts`
- Tenant context via `getCurrentTenantContext()` from `../tenancy/middleware.ts`
- Route files exported as `export default app` and mounted in main router

**Builder runner** (from runner.ts):
- `spawnSync` to run OpenCode CLI
- OpenCode invocation: `opencode --dir /path --dangerously-skip-permissions`
- Runs are tracked in SQLite with `builder_runs` and `builder_passes` tables
- SSE events broadcast on pass completion

**Frontend** (from App.tsx):
- Router: `wouter` with `<Switch><Route>` pattern
- NavRegistry: `app/lib/navRegistry.ts` defines route status (core/advanced/labs/hidden)
- Components in `app/components/`, pages in `app/routes/`

**Gate-relevant patterns**:
- TypeScript compiled with `bun tsc`
- Files written to disk during builder passes
- Git used for version control in the project root
- Model names that MUST be logical aliases: `editorial-cloud-heavy`, `editorial-cloud-fast`,
  `editorial-fast`, `editorial-heavy`, `coding-heavy`, `coding-fast`, `mimule-chat`, `routing-cheap`
- Model strings that are FORBIDDEN in code: `gemma4:`, `qwen2`, `qwen3:`, `llama`, `deepseek`,
  `gpt-4`, `claude-3`, `mistral`
"""

FEATURE_SPEC = """
## Feature: BuilderWatchdog

The control surface has a builder system that runs OpenCode agents to implement features.
When builder agents write code, they make mistakes — hardcoded model names, wrong token limits,
missing route registrations, TypeScript errors — and currently a human must catch these manually.

**BuilderWatchdog** is a QA layer that:

1. **Gets called after each builder pass** (webhook from builder runner) with the list of files written
2. **Runs code gates** against each written file:
   - `ModelNameGate`: reject any `.ts/.tsx` file containing raw model strings like `gemma4:`, `qwen2`,
     `qwen3:`, `llama`, `deepseek`, `gpt-4`, `claude-3`, `mistral` — must use logical LiteLLM aliases
   - `MaxTokensGate`: reject `max_tokens` values ≤ 1024 in any TypeScript file
   - `RouteRegistrationGate`: if a `*Page.tsx` was written, verify it appears in `app/App.tsx`
     AND `app/lib/navRegistry.ts`
   - `TypeScriptGate`: run `bun tsc --noEmit` in the project root; fail on errors
   - `ImportResolutionGate`: verify every local import (`from './'`, `from '../'`) in written files
     resolves to an existing path on disk
3. **If all gates pass**: approve the pass, continue builder
4. **If gates fail**:
   - Attempt 1: dispatch OpenCode with a targeted fix prompt (specific violations listed)
   - Attempt 2: dispatch OpenCode with a different angle if first fix failed
   - Attempt 3: `git stash` the failing files, re-queue the pass with enriched prompt that includes
     the violations history
5. **Persists violations** in SQLite (`watchdog_violations` table) for audit and frontend display
6. **Broadcasts SSE events** so the frontend can show a live "QA badge" on each pass
"""


def call_litellm(messages: list, max_tokens: int = MAX_TOKENS, retries: int = 2) -> str:
    """Call LiteLLM with retry logic."""
    url = f"{LITELLM_URL}/v1/chat/completions"
    headers = {"Content-Type": "application/json"}

    # Try to get master key from environment
    master_key = os.environ.get("LITELLM_MASTER_KEY", "")
    if master_key:
        headers["Authorization"] = f"Bearer {master_key}"

    payload = {
        "model": MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }

    for attempt in range(retries + 1):
        try:
            print(f"  [LiteLLM] attempt {attempt + 1}/{retries + 1}...", flush=True)
            resp = requests.post(url, json=payload, headers=headers, timeout=TIMEOUT)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            tokens_used = data.get("usage", {}).get("completion_tokens", "?")
            print(f"  [LiteLLM] got {tokens_used} completion tokens", flush=True)
            return content
        except requests.exceptions.Timeout:
            print(f"  [LiteLLM] TIMEOUT on attempt {attempt + 1}", flush=True)
            if attempt == retries:
                raise
        except requests.exceptions.HTTPError as e:
            print(f"  [LiteLLM] HTTP error: {e}", flush=True)
            if attempt == retries:
                raise
            time.sleep(5)
        except Exception as e:
            print(f"  [LiteLLM] error: {e}", flush=True)
            if attempt == retries:
                raise
            time.sleep(5)

    raise RuntimeError("LiteLLM call failed after all retries")


def truncate_context(context_parts: list, max_chars: int = 3000) -> str:
    """Join context parts and truncate to last max_chars characters."""
    full = "\n\n---\n\n".join(context_parts)
    if len(full) > max_chars:
        return "...[earlier context truncated]...\n\n" + full[-max_chars:]
    return full


def write_pass_file(pass_num: int, role: str, content: str) -> str:
    """Write pass output to debug file."""
    safe_role = role.lower().replace(" ", "-")
    path = os.path.join(OUTPUT_DIR, f"pass-{pass_num}-{safe_role}.md")
    with open(path, "w") as f:
        f.write(f"# Pass {pass_num}: {role}\n\n")
        f.write(content)
    print(f"  [write] {path}", flush=True)
    return path


def run_pass(pass_num: int, role: str, system_prompt: str, user_prompt: str) -> str:
    """Run a single planning pass."""
    print(f"\n{'='*60}", flush=True)
    print(f"PASS {pass_num}: {role}", flush=True)
    print(f"{'='*60}", flush=True)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    output = call_litellm(messages)
    write_pass_file(pass_num, role, output)
    return output


# ─────────────────────────────────────────────────────────────
# PASS 1: Architect
# ─────────────────────────────────────────────────────────────

ARCHITECT_SYSTEM = """You are a senior software architect reviewing a new feature specification.
Your job is to design the high-level architecture, identify integration points, and flag technical risks.
Respond in structured markdown. Be concrete and specific. No fluff."""

def build_architect_prompt() -> str:
    return f"""
{CODEBASE_CONTEXT}

{FEATURE_SPEC}

As the **Architect**, produce:
1. **Component Map** — list every new file/module needed (server, frontend, DB)
2. **Integration Points** — exactly where BuilderWatchdog hooks into the existing runner.ts
3. **Gate Architecture** — how gates are structured (interface, execution order, short-circuit logic)
4. **SSE Integration** — how watchdog events coexist with existing brainstorm/builder SSE streams
5. **Retry & Rollback Flow** — detailed state machine for the 3-attempt retry with git stash
6. **Technical Risks** — top 3 risks and mitigations
7. **DB Schema Sketch** — `watchdog_runs` and `watchdog_violations` table shapes
""".strip()


# ─────────────────────────────────────────────────────────────
# PASS 2: Backend Engineer
# ─────────────────────────────────────────────────────────────

BACKEND_SYSTEM = """You are a senior backend engineer implementing a Node.js/TypeScript/Bun service.
Your job is to specify exact TypeScript implementations: interfaces, function signatures, SQL, CLI patterns.
Respond in structured markdown with concrete code blocks. Be exhaustive."""

def build_backend_prompt(architect_output: str) -> str:
    ctx = truncate_context([architect_output])
    return f"""
{CODEBASE_CONTEXT}

{FEATURE_SPEC}

## Architect's Design (previous pass)
{ctx}

As the **Backend Engineer**, specify:

1. **TypeScript Interfaces** — complete `Gate`, `GateResult`, `Violation`, `WatchdogRun` interfaces
2. **Gate Implementations** (full TypeScript code for each):
   - `ModelNameGate` — scan file content with regex
   - `MaxTokensGate` — parse max_tokens assignments
   - `RouteRegistrationGate` — read App.tsx + navRegistry.ts, check for page component name
   - `TypeScriptGate` — `spawnSync('bun', ['tsc', '--noEmit'])` with error parsing
   - `ImportResolutionGate` — parse import statements, check `existsSync(resolved_path)`
3. **DB Migration SQL** — complete `CREATE TABLE IF NOT EXISTS` for `watchdog_runs` and `watchdog_violations`
4. **`POST /api/watchdog/review` handler** — full Hono route, auth check, body validation, gate execution
5. **`broadcastWatchdogEvent` function** — following brainstorm-stream.ts pattern exactly
6. **OpenCode dispatcher** — exact CLI invocation with `--dir /opt/opencode-control-surface --dangerously-skip-permissions`
7. **`rollbackAndRequeue` function** — git stash specific files, update DB, re-queue with enriched prompt
8. **Integration in runner.ts** — exact lines to add after builder pass completes (webhook call pattern)
""".strip()


# ─────────────────────────────────────────────────────────────
# PASS 3: Security Analyst
# ─────────────────────────────────────────────────────────────

SECURITY_SYSTEM = """You are a security analyst auditing a new feature before implementation.
Your job is to identify attack surfaces, injection risks, path traversal, and auth gaps.
Respond in structured markdown. Be specific about risks and concrete mitigations."""

def build_security_prompt(context_parts: list) -> str:
    ctx = truncate_context(context_parts)
    return f"""
{CODEBASE_CONTEXT}

{FEATURE_SPEC}

## Previous Analysis
{ctx}

As the **Security Analyst**, audit:

1. **Path Traversal Risks** — files passed in watchdog payload could escape project root
2. **Command Injection** — OpenCode CLI invocation with user-controlled file paths
3. **Auth on POST /api/watchdog/review** — can internal services bypass auth? Should it be internal-only?
4. **SSE Information Leak** — tenant isolation for watchdog events
5. **Git Operations Security** — `git stash` in shared repo, race conditions
6. **Rate Limiting** — what stops a bad actor from flooding the watchdog endpoint?
7. **Violation Storage** — sensitive code snippets stored in SQLite; access controls needed
8. **Recommended Mitigations** — for each risk, concrete code-level fix
""".strip()


# ─────────────────────────────────────────────────────────────
# PASS 4: UX Designer
# ─────────────────────────────────────────────────────────────

UX_SYSTEM = """You are a senior UX designer for a developer-facing control surface dashboard.
Your job is to design the frontend experience: component structure, state, and user interactions.
Respond in structured markdown with component pseudo-code/TSX snippets."""

def build_ux_prompt(context_parts: list) -> str:
    ctx = truncate_context(context_parts)
    return f"""
{CODEBASE_CONTEXT}

{FEATURE_SPEC}

## Previous Analysis
{ctx}

As the **UX Designer**, design:

1. **WatchdogBadge Component** — per-pass badge showing: pending / running / pass / fail / fixing
   - Props interface, state machine, color coding
   - TSX pseudo-code for the badge
2. **WatchdogPanel Component** — expandable panel showing violations list for a pass
   - Each violation: gate name, file path, line number, violation text, fix status
3. **Integration in BuilderPage** — where exactly to embed WatchdogBadge (next to pass cards)
4. **SSE Subscription** — useEffect hook connecting to `/api/watchdog/stream/:runId`
5. **Toast Notifications** — when watchdog blocks a pass vs. when it auto-fixes
6. **Error States** — watchdog itself fails (LiteLLM down, gate error); graceful degradation
7. **Accessibility** — ARIA labels for status badges
""".strip()


# ─────────────────────────────────────────────────────────────
# PASS 5: Critic
# ─────────────────────────────────────────────────────────────

CRITIC_SYSTEM = """You are a harsh but constructive technical critic reviewing a feature design.
Your job is to poke holes, find gaps, and demand clarity on ambiguities before implementation.
Respond in structured markdown. Be direct and specific."""

def build_critic_prompt(context_parts: list) -> str:
    ctx = truncate_context(context_parts)
    return f"""
{CODEBASE_CONTEXT}

{FEATURE_SPEC}

## All Previous Analysis
{ctx}

As the **Critic**, challenge:

1. **Gate False Positives** — ModelNameGate: will it flag model names in comments or string literals
   in tests? How to handle legitimate occurrences?
2. **TypeScriptGate Performance** — running `bun tsc --noEmit` on every pass could take 10–30s;
   is this acceptable? What's the timeout strategy?
3. **Retry Logic Completeness** — what if OpenCode fix dispatch itself fails? What's the timeout?
4. **Git Stash Side Effects** — git stash is global; what if another process is also modifying files?
5. **Webhook vs. Direct Call** — why a webhook? Runner.ts is in the same process; direct function
   call is simpler and faster. Justify the design choice.
6. **SSE Stream Multiplexing** — adding a third SSE stream type; should we unify all builder events
   into one stream instead?
7. **Missing Gates** — are there other common mistakes that should be gated? (e.g., console.log
   left in production code, hardcoded ports, missing error handling)
8. **Recommended Resolutions** — for each criticism, propose the fix that should be in the final plan
""".strip()


# ─────────────────────────────────────────────────────────────
# PASS 6: Synthesizer (produces V1 + V2)
# ─────────────────────────────────────────────────────────────

SYNTHESIZER_SYSTEM = """You are a technical writer and architect synthesizing multi-pass analysis
into two definitive plan documents. You must be exhaustive, concrete, and production-ready.
No hedging, no TODO placeholders — every section must be fully specified."""

def build_v1_prompt(context_parts: list) -> str:
    ctx = truncate_context(context_parts)
    return f"""
{FEATURE_SPEC}

## Expert Analysis (Architect + Backend + Security + UX + Critic)
{ctx}

Write **WATCHDOG_PLAN_V1.md** — a non-technical stakeholder plan.

Requirements:
- Target audience: product owners, operators, non-engineers
- Length: ~500 lines of markdown
- Must include ALL of these sections (use these exact headings):

# BuilderWatchdog — Product Plan V1

## Executive Summary
(2-3 paragraphs: what it is, why it matters, what it replaces)

## The Problem We're Solving
(current pain: human QA burden, common mistakes, cost of broken builds)

## What BuilderWatchdog Does
(plain language walkthrough of all 5 gates — no code, use analogies)

## How It Works — Step by Step
(numbered user journey from "builder agent writes code" to "QA badge shows green")

## The Retry & Recovery System
(explain 3-attempt system in plain language, git stash explained as "safe shelf")

## What the Dashboard Shows
(describe WatchdogBadge, WatchdogPanel, toast notifications)

## Success Criteria
(5 measurable criteria with target values)

## What We Are NOT Building (Scope Boundaries)
(3-5 explicit out-of-scope items)

## Risk Register
(table: Risk | Likelihood | Impact | Mitigation)

## Rollout Plan
(Phase 1: gates only, Phase 2: auto-fix, Phase 3: frontend badge — with success gates per phase)

## Glossary
(define: Gate, Violation, WatchdogRun, SSE, git stash, LiteLLM alias)

Write the full document now. Minimum 500 lines.
""".strip()


def build_v2_prompt(context_parts: list, v1_content: str) -> str:
    ctx = truncate_context(context_parts)
    return f"""
{CODEBASE_CONTEXT}

{FEATURE_SPEC}

## Expert Analysis Summary
{ctx}

## V1 Plan (for reference)
{v1_content[:2000]}...

Write **WATCHDOG_PLAN_V2.md** — a complete technical implementation guide for a coding agent.

Requirements:
- Target audience: a coding agent (OpenCode) implementing this feature
- Length: 800-1000 lines of markdown
- Every section must be concrete: exact file paths, full TypeScript code, complete SQL
- No vague statements — every claim must be actionable

# BuilderWatchdog — Technical Implementation Plan V2

## File Manifest
(complete list of every file to create/modify with absolute paths)

## Database Migration
(complete SQL for watchdog_runs and watchdog_violations tables, integrated into migrateDashboardDb)

## TypeScript Interfaces
(complete interface definitions: Gate, GateResult, Violation, WatchdogRun, WatchdogReviewRequest)

## Gate Implementations

### ModelNameGate
(full TypeScript implementation)

### MaxTokensGate
(full TypeScript implementation)

### RouteRegistrationGate
(full TypeScript implementation with App.tsx and navRegistry.ts checks)

### TypeScriptGate
(full TypeScript implementation using spawnSync)

### ImportResolutionGate
(full TypeScript implementation)

## WatchdogRunner
(the main orchestrator: runs all gates, handles retries, calls OpenCode dispatcher)

## POST /api/watchdog/review Handler
(complete Hono route with auth, body validation, and watchdog invocation)

## GET /api/watchdog/stream/:runId
(SSE stream handler following brainstorm-stream.ts pattern)

## broadcastWatchdogEvent
(complete implementation following existing SSE pattern)

## OpenCode Dispatcher
(exact CLI invocation, prompt construction, spawnSync call)

## Rollback Function
(git stash specific files, DB update, re-queue logic)

## Runner Integration
(exact lines to add to runner.ts after builder pass completes)

## WatchdogBadge Component
(complete TSX with props, state, useEffect for SSE)

## WatchdogPanel Component
(complete TSX for violations list)

## Route Registration
(changes to App.tsx and navRegistry.ts)

## Server Entry Point
(changes to mount /api/watchdog routes)

## Security Controls
(exact code for path validation, rate limiting, tenant isolation)

## Deployment Checklist
(ordered steps to deploy without breaking existing builder)

Write the full document now. Minimum 800 lines. Include full code blocks for every implementation.
""".strip()


def main():
    print("\n" + "="*60)
    print("BuilderWatchdog Planning Script")
    print("="*60 + "\n")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    context_parts = []

    # ── Pass 1: Architect ──────────────────────────────────────
    arch_output = run_pass(1, "Architect", ARCHITECT_SYSTEM, build_architect_prompt())
    context_parts.append(f"## ARCHITECT\n{arch_output}")

    # ── Pass 2: Backend Engineer ───────────────────────────────
    backend_output = run_pass(2, "Backend Engineer", BACKEND_SYSTEM, build_backend_prompt(arch_output))
    context_parts.append(f"## BACKEND ENGINEER\n{backend_output}")

    # ── Pass 3: Security Analyst ───────────────────────────────
    security_output = run_pass(3, "Security Analyst", SECURITY_SYSTEM, build_security_prompt(context_parts))
    context_parts.append(f"## SECURITY ANALYST\n{security_output}")

    # ── Pass 4: UX Designer ────────────────────────────────────
    ux_output = run_pass(4, "UX Designer", UX_SYSTEM, build_ux_prompt(context_parts))
    context_parts.append(f"## UX DESIGNER\n{ux_output}")

    # ── Pass 5: Critic ─────────────────────────────────────────
    critic_output = run_pass(5, "Critic", CRITIC_SYSTEM, build_critic_prompt(context_parts))
    context_parts.append(f"## CRITIC\n{critic_output}")

    # ── Pass 6a: Synthesizer → V1 ──────────────────────────────
    print(f"\n{'='*60}", flush=True)
    print("PASS 6a: Synthesizer → WATCHDOG_PLAN_V1.md", flush=True)
    print(f"{'='*60}", flush=True)

    v1_messages = [
        {"role": "system", "content": SYNTHESIZER_SYSTEM},
        {"role": "user", "content": build_v1_prompt(context_parts)},
    ]
    v1_content = call_litellm(v1_messages, max_tokens=6000)

    v1_path = os.path.join(OUTPUT_DIR, "WATCHDOG_PLAN_V1.md")
    with open(v1_path, "w") as f:
        f.write(v1_content)
    print(f"  [write] {v1_path}", flush=True)

    v1_lines = len(v1_content.splitlines())
    print(f"  V1: {v1_lines} lines", flush=True)

    # ── Pass 6b: Synthesizer → V2 ──────────────────────────────
    print(f"\n{'='*60}", flush=True)
    print("PASS 6b: Synthesizer → WATCHDOG_PLAN_V2.md", flush=True)
    print(f"{'='*60}", flush=True)

    v2_messages = [
        {"role": "system", "content": SYNTHESIZER_SYSTEM},
        {"role": "user", "content": build_v2_prompt(context_parts, v1_content)},
    ]
    v2_content = call_litellm(v2_messages, max_tokens=6000)

    v2_path = os.path.join(OUTPUT_DIR, "WATCHDOG_PLAN_V2.md")
    with open(v2_path, "w") as f:
        f.write(v2_content)
    print(f"  [write] {v2_path}", flush=True)

    v2_lines = len(v2_content.splitlines())
    print(f"  V2: {v2_lines} lines", flush=True)

    # ── Verify ─────────────────────────────────────────────────
    print(f"\n{'='*60}", flush=True)
    print("VERIFICATION", flush=True)
    print(f"{'='*60}", flush=True)

    assert os.path.exists(v1_path), f"V1 not found: {v1_path}"
    assert os.path.exists(v2_path), f"V2 not found: {v2_path}"
    assert v1_lines >= 200, f"V1 too short: {v1_lines} lines (need >= 200)"
    assert v2_lines >= 200, f"V2 too short: {v2_lines} lines (need >= 200)"

    print(f"\nDONE: V1={v1_lines} V2={v2_lines}")


if __name__ == "__main__":
    main()
