# Pass 5: Critic

# BuilderWatchdog Feature Design — Critical Review

This review systematically addresses each identified weakness in the current design. Each section states the problem, its severity, and a recommended resolution.

---

## 1. Gate False Positives — ModelNameGate

**Problem:** The regex-based `ModelNameGate` will flag model names appearing in:
- Comments (`// TODO: remove gemma4: reference`)
- Test fixtures (`expect(model).toContain('llama')`)
- Documentation strings
- Legitimate third-party library imports that mention these names

**Severity:** High. False positives will cause valid code to fail QA, triggering unnecessary retry cycles and eroding trust in the system.

**Root cause:** The design treats all `.ts/.tsx` files identically without context awareness.

**Recommended resolution:**
```
ModelNameGate must operate in AST-aware mode, not regex.
- Parse with @typescript-eslint/parser (or ts-morph)
- Inspect only:
  - StringLiteral nodes in CallExpression arguments
  - StringLiteral nodes in ObjectExpression properties (value side)
- Ignore:
  - Comments (anywhere)
  - StringLiteral nodes in type positions (TSTypeAnnotation)
  - Test files (filename contains .test.ts, .spec.ts, __fixtures__)
```
Add a config file `watchdog.config.json` in project root with:
```json
{
  "modelNameGate": {
    "excludePatterns": ["**/*.test.ts", "**/*.spec.ts", "**/fixtures/**"],
    "allowedContexts": ["callExpression", "propertyAssignment"]
  }
}
```

---

## 2. TypeScriptGate Performance

**Problem:** `bun tsc --noEmit` on a medium-sized codebase runs 10–30 seconds. Running this after *every* builder pass (which may be frequent during active development) creates a bottleneck.

**Severity:** Medium-High. If a pass writes 3 files and TypeScript check takes 20s, the watchdog adds 6x overhead to the pass completion time.

**Questions the design doesn't answer:**
- What is the timeout? What happens if tsc hangs?
- Is it run on the full project or only on changed files?
- Can it be parallelized with other gates?

**Recommended resolution:**
```
1. Run tsc on a focused scope: only the directories/files affected by the pass
   - Use `bun tsc --noEmit --project tsconfig.json src/app/api/featureX/`
   - If pass touched files in 2 directories, run 2 parallel tsc invocations

2. Set hard timeout: 30 seconds max, then fail with "type-check-timeout" violation
   - This prevents one slow check from blocking the entire system

3. Cache results: store a hash of (tsconfig + all .ts files) → last tsc result
   - If nothing changed since last pass, skip tsc entirely

4. Make it optional via config: "typeScriptGate": { "enabled": true, "timeoutMs": 30000 }
```

---

## 3. Retry Logic Completeness

**Problem:** The design describes 3 retry attempts but doesn't specify:
- What happens if the *dispatch* to OpenCode fails (network error, LiteLLM down)?
- What is the timeout for each dispatch attempt?
- What happens if the fix prompt itself is malformed?

**Severity:** High. If the watchdog can't dispatch fixes, it enters an infinite failure loop with no recovery path.

**Recommended resolution:**
```
Add explicit error handling for dispatch failures:

Attempt 1 dispatch:
  - Timeout: 60 seconds
  - Retry: 3 times with exponential backoff (2s, 4s, 8s)
  - If all fail: mark pass as "watchdog-dispatch-failed", alert human

Attempt 2 dispatch:
  - Same timeout/retry policy
  - If fail: mark pass as "watchdog-retry-failed", alert human

Attempt 3:
  - If dispatch fails: do NOT git stash (too destructive without human approval)
  - Mark pass as "watchdog-exhausted", require manual intervention

Log every dispatch attempt to watchdog_violations with status "dispatch-pending" | "dispatch-sent" | "dispatch-failed"
```

---

## 4. Git Stash Side Effects

**Problem:** `git stash` is a global operation affecting the entire working tree. If:
- Another developer is working on the same machine
- A CI pipeline runs concurrently
- The frontend hot-reload system modifies files

...then `git stash` will capture unintended changes and `git stash pop` may fail or create conflicts.

**Severity:** High. Data loss is possible.

**Recommended resolution:**
```
Never use git stash for watchdog operations. Use a different strategy:

Option A (preferred): Create a separate "quarantine" branch
  - git checkout -b watchdog/quarantine/{runId}
  - Commit failing files to that branch
  - Human can review and merge later

Option B: Rename + move
  - mv file.ts file.ts.watchdog-fail
  - Write corrected version to file.ts
  - Original file preserved in working directory for inspection

Option C (if stash is required): Scope it tightly
  - git stash push -- path/to/file1.ts path/to/file2.ts
  - Only stash the specific failing files, not entire repo
  - Use --include-untracked carefully
```

---

## 5. Webhook vs. Direct Call

**Problem:** The design specifies a "webhook from builder runner" but `runner.ts` is in the same process. A direct function call is simpler, faster, and avoids network overhead.

**Severity:** Low-Medium. This is an architectural inconsistency, not a bug.

**Recommended resolution:**
```
The watchdog should be invoked as a direct function, not webhook:

// In runner.ts, after files are written:
import { runWatchdogGates } from './watchdog/runner.ts';

const gateResults = await runWatchdogGates({
  runId: currentRun.id,
  files: writtenFiles,  // { path: string, content: string }[]
  tenantId: currentRun.tenantId,
});

if (gateResults.allPassed) {
  // continue builder
} else {
  // trigger retry logic
}
```

The webhook pattern is only justified if:
- Runner runs in a separate process/container
- You need to replay watchdog runs asynchronously
- External services trigger builder passes

If none of these apply, direct invocation reduces latency and complexity.

---

## 6. SSE Stream Multiplexing

**Problem:** The design adds a third SSE stream (`/api/watchdog/stream/:runId`). The codebase already has:
- `brainstorm-stream.ts` for agent events
- Builder pass completion events

Adding more streams creates:
- Multiple EventSource connections in the frontend
- No unified ordering across streams
- Increased connection overhead

**Severity:** Medium. UX issue — frontend may show inconsistent event ordering.

**Recommended resolution:**
```
Option A (recommended): Extend existing builder SSE stream
  - Add event types: "watchdog:status", "watchdog:violation", "watchdog:fix-attempt"
  - Frontend subscribes to ONE stream per runId
  - Events are naturally ordered with builder events

Option B: Keep separate but document clearly
  - If watchdog events are high-volume (many violations), separate stream isolates that noise
  - Document that frontend must coordinate two EventSources
  - Provide a helper hook: useBuilderStream(runId) that merges both

If choosing Option B, ensure both streams use the same tenant:session key format for consistency.
```

---

## 7. Missing Gates

**Problem:** The design covers 5 gates but omits common mistakes that builders frequently make:

| Missing Gate | Rationale |
|-------------|------------|
| `ConsoleLogGate` | `console.log` left in production code — security/performance risk |
| `HardcodedPortGate` | `3000`, `4000`, `5432` hardcoded instead of env vars |
| `ErrorHandlingGate` | Functions with `throw` but no try/catch in callers |
| `EnvVarGate` | Code references `process.env.MISSING_VAR` that isn't in `.env.example` |
| `SensitiveDataGate` | Hardcoded API keys, passwords, or secrets in code |
| `TodoGate` | `TODO:` or `FIXME:` comments left in committed code |

**Severity:** Low-Medium. These are nice-to-haves that increase QA quality.

**Recommended resolution:**
```
Add these gates incrementally, not all at once:

Phase 1 (MVP): ConsoleLogGate + HardcodedPortGate
  - Simple regex checks, low false-positive rate
  - High value: catches common mistakes

Phase 2: EnvVarGate
  - Parse .env.example, verify all process.env.X references exist
  - Requires understanding of AST

Phase 3: ErrorHandlingGate
  - Complex: requires control-flow analysis
  - Lower priority

Configure via watchdog.config.json:
{
  "gates": {
    "consoleLog": { "enabled": true },
    "hardcodedPort": { "enabled": true },
    "errorHandling": { "enabled": false }  // opt-in for now
  }
}
```

---

## 8. Recommended Resolutions — Summary

| # | Issue | Recommended Fix |
|---|-------|------------------|
| 1 | False positives | AST-aware inspection, exclude test files via config |
| 2 | tsc performance | Scope to affected dirs, 30s timeout, cache results |
| 3 | Retry dispatch failures | Explicit timeout/retry, escalate to human on exhaustion |
| 4 | Git stash side effects | Use quarantine branch or scoped `git stash push -- path` |
| 5 | Webhook overhead | Direct function call (unless runner is separate process) |
| 6 | Multiple SSE streams | Extend existing builder stream OR document multi-stream coordination |
| 7 | Missing gates | Add ConsoleLogGate + HardcodedPortGate in Phase 1 |

---

## Additional Concerns Not in Original List

### A. Gate Execution Order
The design doesn't specify gate execution order. If `ModelNameGate` fails, should `TypeScriptGate` still run?

**Recommendation:** Run gates in order of speed/cost:
1. ImportResolutionGate (fast, local file check)
2. ModelNameGate (fast, regex/AST on single file)
3. MaxTokensGate (fast, regex)
4. RouteRegistrationGate (fast, file existence check)
5. TypeScriptGate (slow, full project check)

Stop at first failure to minimize compute. Only run all gates if explicitly requested.

### B. Violation Deduplication
If the same violation exists across 3 retry attempts, should it be logged 3 times or updated?

**Recommendation:** Update existing violation record:
```sql
UPDATE watchdog_violations 
SET attempt_count = attempt_count + 1, 
    last_seen_at = NOW(),
    status = 'pending-fix' | 'fixed' | 'exhausted'
WHERE run_id = ? AND file_path = ? AND gate_type = ?;
```

### C. Database Migration Missing
The design references `watchdog_violations` table but doesn't specify the migration.

**Recommendation:** Add to `migrateDashboardDb()`:
```sql
CREATE TABLE IF NOT EXISTS watchdog_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES builder_runs(id),
  pass_id INTEGER REFERENCES builder_passes(id),
  gate_type TEXT NOT NULL,  -- 'modelName'|'maxTokens'|'routeRegistration'|'typeScript'|'importResolution'
  file_path TEXT NOT NULL,
  line_number INTEGER,
  violation_message TEXT NOT NULL,
  attempt_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending',  -- 'pending'|'fixed'|'exhausted'|'ignored'
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_watchdog_run ON watchdog_violations(run_id);
CREATE INDEX idx_watchdog_status ON watchdog_violations(status);
```

---

## Final Verdict

The feature design is **sound in concept** but **under-specified in critical paths**. The retry logic, gate false positives, and git stash behavior are the highest-risk areas and must be resolved before implementation.

**Recommended implementation order:**
1. Add `watchdog_violations` table migration
2. Implement gates 1-4 (fast gates) with AST-aware ModelNameGate
3. Add TypeScriptGate with timeout/caching
4. Add SSE integration (extend existing stream)
5. Add retry logic with human escalation on dispatch failure
6. Add missing gates (ConsoleLog, HardcodedPort) in follow-up