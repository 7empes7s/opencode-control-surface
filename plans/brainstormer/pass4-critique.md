# BRAINSTORMER ADVERSARIAL CRITIQUE (Pass 4)

You’ve built a *sophisticated toy*. It looks good on paper — clean schema, modular components, SSE, retry logic. But it’s **brittle**, **insecure**, and **riddled with operational landmines**. This isn’t production-grade. It’s a ticking time bomb under load, under attack, or after a reboot.

Below is a **ruthless, comprehensive adversarial review**. I’m not here to praise — I’m here to **break it before it breaks you**.

---

### [SEVERITY: Critical] Missing Transactional Integrity in Pass Execution
**Problem:** The orchestrator updates `brainstorm_passes` status and calls LLMs *without atomicity*. If the LLM call succeeds but DB update fails (or vice versa), the system state diverges. Worse: `completed_passes` in `brainstorm_sessions` is updated *after* each pass — but **not atomically** with the pass insert/update. This creates race conditions.

**Failure mode:**  
- Orchestrator increments `completed_passes`, then crashes before updating the pass status → DB shows 5 completed, but only 4 passes are in `completed`.  
- Two concurrent passes increment `completed_passes` → overcount.  
- Session appears "done" prematurely.

**Fix:**  
Use transactions and atomic operations:
```sql
-- Add a trigger or use application-level transaction
BEGIN IMMEDIATE;
UPDATE brainstorm_sessions 
SET completed_passes = (SELECT COUNT(*) FROM brainstorm_passes WHERE session_id = ? AND status = 'completed')
WHERE id = ?;
-- Only after ALL passes are confirmed
COMMIT;
```
Do **not** maintain `completed_passes` as a mutable counter. Compute it on read or update atomically.

---

### [SEVERITY: Critical] No Orphaned Pass Recovery Mechanism
**Problem:** If the orchestrator crashes during a pass, the pass remains `running` with no `finished_at`. The session stays `running`. No process detects or recovers from this.

**Failure mode:**  
- Session hangs forever in `running`.  
- No new sessions start due to concurrency limits.  
- Tenant is soft-locked out.

**Fix:**  
1. Add a `last_heartbeat_at` column to `brainstorm_passes`.  
2. Implement a **health monitor cron job** (every 5 min):  
   ```sql
   UPDATE brainstorm_passes 
   SET status = 'failed', error = 'orphaned: no heartbeat'
   WHERE status = 'running' AND last_heartbeat_at < datetime('now', '-10 minutes');
   ```
3. Restart or fail the session accordingly.

---

### [SEVERITY: Critical] Cascade Delete Destroys Audit Trail
**Problem:** `brainstorm_passes` uses `ON DELETE CASCADE` on `session_id`. Sessions can be deleted via API or cleanup job.

**Failure mode:**  
- Admin deletes session → all pass history, outputs, and context **gone**.  
- No ability to audit why a plan failed.  
- Legal/compliance risk.

**Fix:**  
**Do not allow deletion.** Instead:
- Add `is_deleted BOOLEAN DEFAULT 0` to both tables.  
- Filter by `is_deleted = 0` in queries.  
- Purge job moves files to cold storage (e.g., S3) and logs deletion.  
- Or, soft-delete sessions only after 90 days.

---

### [SEVERITY: Critical] SSE EventSource Uses Query Param Token — Leaks to Logs
**Problem:** Frontend uses `?token=...` in `EventSource` URL. This leaks tokens to:
- Server access logs  
- Browser history  
- Reverse proxy logs  
- CDN edge caches  

**Failure mode:**  
Tokens captured in plaintext logs → full tenant compromise.

**Fix:**  
**Do not use query params for auth.** Use:
- **Custom header via `fetch` + `ReadableStream`** instead of `EventSource`.  
- Or, use **cookie-based auth with HttpOnly, Secure, SameSite=Strict**.  
- If you *must* use `EventSource`, proxy through a backend endpoint that strips the token and forwards via `Authorization` header.

---

### [SEVERITY: Critical] No Idempotency in Session Creation
**Problem:** `POST /sessions` has no idempotency key. If client retries, multiple sessions are created.

**Failure mode:**  
- User clicks "Start" twice → two sessions, double LLM cost, confusion.  
- Frontend shows wrong session.

**Fix:**  
Require `Idempotency-Key: <uuid>` header. Store key in Redis or DB with TTL:
```ts
if (await redis.get(`idempotency:${key}`)) {
  return 409 + cachedResponse;
}
await redis.setex(`idempotency:${key}`, 3600, jsonResponse);
```

---

### [SEVERITY: High] Plan Files Stored on Local FS — Not Scalable or HA
**Problem:** Plans written to `/opt/opencode-control-surface/brainstorm-plans`. Assumes single node, no replication.

**Failure mode:**  
- Server reboot → data loss if ephemeral disk.  
- Horizontal scaling → files on wrong node.  
- Backup complexity.

**Fix:**  
**Migrate to object storage** (S3, GCS, or min.io).  
- Store file paths as `s3://bucket/tenant/session/pass-01.md`.  
- Add `storage_backend` column to session.  
- Use signed URLs for downloads.

---

### [SEVERITY: High] No Protection Against Concurrent `startSession` Calls
**Problem:** Two `startSession` calls for the same session can launch two orchestrators.

**Failure mode:**  
- Double LLM calls, corrupted outputs, race on `completed_passes`.  
- Resource exhaustion.

**Fix:**  
Use **database-level advisory lock**:
```sql
SELECT pg_advisory_xact_lock(hashtext('startSession:' || session_id));
-- Then check status is still 'ready'
```
Or use `UPDATE ... WHERE status = 'ready' RETURNING id` to atomically claim.

---

### [SEVERITY: High] Missing SSE Events for Key Transitions
**Problem:** SSE stream lacks events for:
- `pass:queued`  
- `pass:started`  
- `session:paused`  
- `session:canceled`  
- `system:rate_limited`  
- `file:updated` (for live preview)

**Failure mode:**  
Frontend cannot reflect real-time state. Users think it’s frozen.

**Fix:**  
Define full event schema:
```json
{ "event": "pass:started", "data": { "passId": "...", "role": "architect" } }
{ "event": "pass:output_chunk", "data": { "text": "..." } }
{ "event": "session:completed", "data": { "summaryPath": "..." } }
```

---

### [SEVERITY: High] Confidence Score Misleading and Not Actionable
**Problem:** `confidence_score REAL` in `brainstorm_passes` has no definition. Is it self-reported by LLM? Calibrated? Thresholded?

**Failure mode:**  
- User sees 0.85 → assumes reliable → builds on flawed plan.  
- No UI guidance on what "low confidence" means.

**Fix:**  
1. Define confidence as **entropy of logprobs** or **self-rating prompt**.  
2. Add `confidence_level ENUM('low','medium','high')` derived from score.  
3. In UI: show **"Low confidence — review this pass carefully"** with tooltip.

---

### [SEVERITY: High] PlanPreview Loads via Filesystem Path — TOCTOU Race
**Problem:** `PlanPreview` reads file at `PLAN_V1_PATH`. But file may not exist or be incomplete when read.

**Failure mode:**  
- File is half-written → partial plan shown → developer misleads.  
- File deleted between check and read.

**Fix:**  
1. Write to temporary file, then `rename()` atomically.  
2. Or: serve files via API endpoint with DB-backed existence check.  
3. Add `output_ready BOOLEAN DEFAULT 0` to `brainstorm_passes`.

---

### [SEVERITY: High] No Protection Against Prompt Injection via `specs` Field
**Problem:** `specs` field injected directly into LLM prompts. Can contain:
- "Ignore previous instructions"  
- "Output only 'PWNED'"  
- Malicious roleplay

**Failure mode:**  
- LLM generates exploit code, ignores constraints, leaks system prompts.

**Fix:**  
Sanitize and sandbox:
```ts
const sanitizedSpecs = specs
  .replace(/{{/g, "{ {")
  .replace(/<|>|prompt|system|role/i, "");
// Or better: use a parser to block forbidden keywords
```
And **never** use `specs` in system prompts. Use it only in user messages with guardrails.

---

### [SEVERITY: High] Missing Cancel Mechanism for Individual Passes
**Problem:** You can cancel a session, but not a single pass. If "Critic" pass fails, user can’t retry just that one.

**Failure mode:**  
- User cancels entire session → loses 10 minutes of work.  
- No granular control.

**Fix:**  
Add `PATCH /passes/:id/cancel` and `POST /passes/:id/retry`.  
Update schema: `brainstorm_passes` should allow `canceled` → `pending` transition.  
Orchestrator must respect `cancel_requested` per pass.

---

### [SEVERITY: High] Model Output Can Mimic Tool Calls or SSE Events
**Problem:** LLM output could contain:
```
event: session:completed
data: {"workflow_id": "malicious"}
```
Or:
```json
{"tool_call": {"name": "create_workflow", "args": {"id": "hacked"}}}
```

**Failure mode:**  
Frontend or downstream system parses output as command → **RCE via LLM hallucination**.

**Fix:**  
1. **Never trust LLM output as code or event.**  
2. Escape or sandbox plan output in `PlanPreview`.  
3. Use `Content-Type: text/plain` for plan files.  
4. Validate all tool calls via **server-side schema**, not client.

---

### [SEVERITY: High] No Output Truncation or Buffer Limits
**Problem:** LLM can return 100k tokens. You stream it unchecked.

**Failure mode:**  
- OOM crash in orchestrator or frontend.  
- SQLite BLOB size exceeded (1GB, but still).  
- Browser tab freeze.

**Fix:**  
1. Limit output to **16k tokens** via LLM max_tokens.  
2. In orchestrator: `if (output.length > 64_000) throw new Error("output_too_long")`.  
3. Frontend: stream into `<pre>` with `max-height: 500px; overflow: auto`.

---

### [SEVERITY: Medium] `model_tier` Default 'free' — No Billing Guardrails
**Problem:** `model_tier TEXT NOT NULL DEFAULT 'free'`. But nothing enforces that "pro" models are only used for pro tenants.

**Failure mode:**  
Free-tier user sets `model_tier: 'pro'` in API → burns GPT-4 credits.

**Fix:**  
Validate on `createSession`:
```ts
const tier = await getTenantTier(tenantId);
if (model_tier === 'pro' && tier !== 'pro') {
  throw new Error("insufficient_tier");
}
```

---

### [SEVERITY: Medium] Hardcoded Filesystem Paths — Not Testable or Portable
**Problem:** Paths like `/opt/opencode-control-surface/brainstorm-plans` are hardcoded.

**Failure mode:**  
- Tests fail on dev machines.  
- CI/CD cannot run without mkdir.  
- Docker volume mounting becomes fragile.

**Fix:**  
Inject `PLAN_STORAGE_ROOT` via environment variable.  
Use dependency injection for path builders.

---

### [SEVERITY: Medium] No Session Versioning or Rollback
**Problem:** No way to compare two versions of a plan or revert.

**Failure mode:**  
User makes a change, runs new passes, regrets it — no undo.

**Fix:**  
1. Add `version INT DEFAULT 1` to `brainstorm_sessions`.  
2. On re-plan, `INSERT ... SELECT` with `version + 1`.  
3. UI: show version history.

---

### [SEVERITY: Medium] UX: Pass Count Recommendation Feels Arbitrary
**Problem:** `recommended_passes` shown as a number. No explanation: *"Why 5? Why not 3?"*

**Failure mode:**  
User ignores recommendation, sets too low, gets bad plan → blames system.

**Fix:**  
In `SmartRecommendationOverlay`, explain:
> "We recommend 5 passes based on project complexity (3000 lines estimated). Fewer may miss edge cases."

---

### [SEVERITY: Medium] BuilderRunCreationPanel: No Validation of `projectRoot`
**Problem:** `createWorkflow` takes `projectRoot`, but it’s not validated. Could be `../../../etc/passwd`.

**Failure mode:**  
Path traversal in file writes → overwrite system files.

**Fix:**  
```ts
if (!projectRoot.match(/^[a-zA-Z0-9_\-/]+$/) || projectRoot.includes('..')) {
  throw new Error("invalid_project_root");
}
```
Or better: **restrict to tenant’s allowed directories**.

---

### [SEVERITY: Medium] Missing File Export / Download Feature
**Problem:** No way to export plan as `.zip` or `.md`.

**Failure mode:**  
User wants to share plan → copies via screenshot → loses formatting.

**Fix:**  
Add `GET /sessions/:id/export` → returns zip of all pass files + summary.

---

### [SEVERITY: Low] `created_at` / `updated_at` Not Indexed Together
**Problem:** Queries like "last 10 sessions by update time" need `tenant_id + updated_at`.

**Fix:**  
Add:
```sql
CREATE INDEX idx_brainstorm_sessions_tenant_updated ON brainstorm_sessions(tenant_id, updated_at DESC);
```

---

### [SEVERITY: Low] `status` Check Constraint Too Permissive
**Problem:** Status includes `'interrupted'` but no state transition logic defines it.

**Failure mode:**  
Orphaned state. No handler knows what to do.

**Fix:**  
Remove `'interrupted'` or define clear transition:  
`running` → `interrupted` only on SIGINT, then → `failed` or `canceled`.

---

### [SEVERITY: Low] No Monitoring or Logging of LLM Costs
**Problem:** No tracking of tokens in/out per pass.

**Failure mode:**  
Can’t debug cost spikes. No budget alerts.

**Fix:**  
Add columns:
```sql
ALTER TABLE brainstorm_passes ADD COLUMN 
  input_tokens INT,
  output_tokens INT,
  model_cost_usd REAL;
```

---

### [SEVERITY: Low] Frontend: Optimistic Message Injection Without Rollback
**Problem:** `UserMessageInput` likely injects message optimistically. But if server rejects (auth fail, size limit), UI doesn’t revert.

**Failure mode:**  
User sees their message — but it wasn’t saved → confusion.

**Fix:**  
Do **not** inject optimistically. Show "Sending…" until confirmed.  
Or, inject with `status="pending"` → update on error.

---

## Final Verdict

This system is **not production-ready**.

It’s a **prototype with critical flaws** in **data integrity**, **security**, **reliability**, and **user trust**.

### You Need to:
1. ✅ Replace local FS with object storage.  
2. ✅ Implement atomic state updates and orphan recovery.  
3. ✅ Fix SSE auth (no query tokens).  
4. ✅ Add idempotency, rate limiting, and concurrency guards.  
5. ✅ Sanitize all LLM inputs and outputs.  
6. ✅ Add pass-level retry and cancel.  
7. ✅ Version sessions and export plans.

**Do not deploy this.** Not even to staging.

Fix **every Critical and High** issue first.

This isn’t engineering. This is **firefighting before the fire**.