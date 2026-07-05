# Auto-apply promotion review (ULTRAPLAN P2.4 / SPEC 10)

**Created**: 2026-07-05. **Companion to**: `MIMULE_MASTER_PLAN_V3.md` ULTRAPLAN 2.4,
`docs/PROVING_CASE_FLAPPER.md` (same honesty format), `server/insights/autoapplyPolicy.ts`
(the code this document justifies).

This is the deliberate-review artifact for expanding the auto-apply tier. Every candidate
below was verified against the action's **real implementation** before the decision was
kept. Where verification contradicted the orchestrator's promotion decision, the candidate
was **refused with evidence** — three of the four planned promotions failed verification.
Refusals are part of the deliverable, not a footnote.

Bottom line: **1 promotion** (`reasoner-remediate:pass-timeout:*`, the largest actionable
class after acknowledge at 13 findings), **3 verification refusals**, **4 decision refusals**,
and a **structural rollback-evidence gate** that now applies to every auto-tier action,
including the pre-existing three.

---

## 1. Corpus (orchestrator-verified, 2026-07-05)

Auto tier before this review: `start-job:model-health:all`, `start-job:infra:doctor-log-rotate`
(SAFE_AUTO_ACTIONS) and `mutate-policy:model:*:cooldown-clear` (normalized policy key).

| Finding class / action family | Count | Decision | Reasoning (short) |
|---|---|---|---|
| *(no `actionDescriptorId`: unregistered-ai-system + stuck-story)* | **623** | nothing to promote | Cannot be auto-applied at ANY tier — there is no action. This is the real gap (see §6). |
| `acknowledge:incident:*` | 31 | **REFUSED (decision)** | Auto-ack makes "acknowledged" stop meaning a human saw it; breaks the SLA/ack model's honesty. Never promote. |
| `reasoner-remediate:pass-timeout:*` | 13 | **PROMOTED** | Verified non-destructive with recorded run ids + cancel affordance (§2). |
| `start-job:model-health:all` | 3 | already auto | Now carries an explicit read-only marker in the affordance map. |
| `start-job:doctor:scan` | 1 | **REFUSED (verification)** | NOT read-only — the premise of the promotion was false (§3.1). |
| `start-job:service:mimule-overseer` | 1 | **REFUSED (verification)** | Not in the execute allowlist; no state capture (§3.2). |
| `start-job:service:mimule-orchestrator` | 1 | **REFUSED (verification)** | Same implementation, same refusal (§3.2). |
| `start-job:service:vast-tunnel` | 1 | **REFUSED (decision)** | GPU/tunnel is off by explicit operator decision; auto-restart fights the operator. |
| `start-job:gateway:route-healthiest` | 1 | **REFUSED (decision)** | Mutates production routing, reasonRequired; deliberate-eyes only (revisit under the T2 rules engine). |
| `mutate-policy:budget` | 1 | **REFUSED (decision)** | Governance-sensitive policy mutation. Never auto. |
| `mutate-policy:gateway-keys` | 1 | **REFUSED (decision)** | Governance-sensitive policy mutation. Never auto. |
| `escalate:incident:*` | 1 | stays review | Escalation creates a draft workflow for a human; automating it defeats its purpose. |

---

## 2. The promotion: `reasoner-remediate:pass-timeout:*`

**What the implementation actually does** (verified in code, 2026-07-05):
`server/api/insights.ts` routes `reasoner-remediate:pass-timeout:<workflowId>:<passId>[:<incidentId>]`
to `reasonerApplyPlaybookHandler("pass-timeout", …)` (`server/api/reasoner.ts:538`), which runs the
built-in playbook's single action `retry-continuation` (`server/reasoner/playbooks.ts:47-53`) →
`startWorkflowRun(workflowId, "reasoner-retry-continuation", "reasoner")` (`server/builder/runner.ts:1746`).

**Verification against the SPEC-10 bar:**

- **Non-destructive** — `startWorkflowRun` creates a NEW `builder_runs` row and a new pass;
  it deletes and cancels nothing. Old runs, passes, and diagnoses stay intact. If the project
  is locked by another run, the *new* run is marked failed and the function throws cleanly —
  existing work is untouched.
- **Respects the rate limit** — the retry only ever fires through `autoApplySafeInsights`,
  inside the shared `maxAutoAppliesPerHour` budget, circuit breaker, and AI-confidence gate.
- **Audit records the created run ids** — `recordPlaybookRun` persists the created run id in
  `reasoner_playbook_runs.result`, and the auto-apply audit row now stores the playbook
  response (the run ids) in `result_json.actionResult` plus the declared rollback affordance.
- **Rollback affordance** — `POST /api/builder/runs/<runId>/cancel`
  (`builderCancelRunHandler`, wired in `server/api/router.ts:921-928`) cancels the retried
  run; the run id needed is the one recorded above.

**Engineering fix required to make the promotion real:** `runAutoApply` previously sent
*every* action to `/api/actions/execute`, which has **no** `reasoner-remediate` branch —
promoting this family without the fix would have failed 100% of the time with
"action not supported" and tripped the circuit breaker. `server/insights/autoapply.ts` now
mirrors `applyInsightCore`'s dispatch split: reasoner remediations go to the playbook apply
handler; everything else goes to the execute handler. A hermetic test proves the full path
(tier → rollback gate → playbook route → audit with run ids → insight `applied`), and a
second test proves a failing dispatch is audited as `failed` so the breaker still sees it.

---

## 3. Verification refusals (the orchestrator planned these as promotions)

### 3.1 `start-job:doctor:scan` — refused: it is not a read-only scan

The promotion premise was "read-only scan … genuinely no mutation". The implementation
contradicts it. The control-surface side (`server/api/execute.ts:258`) POSTs to the
autopipeline at `127.0.0.1:3200/doctor/scan`, which runs `doctorScanRecentStuckItems()`
(`newsbites-autopipeline.mjs:699`) → `dispatchDoctorForItem(item, { source: "timer" })` for
every recently-stuck story. That dispatcher, verified line-by-line:

- **requeues stuck stories** into the live pipeline queue at priority 0 (`enqueue({...})`);
- **sets model cooldowns** (`setModelCooldown(...)` for quality/rate-limit failures) — this
  mutates the same `model-cooldowns.json` policy state that `mutate-policy:model:*:cooldown-clear`
  manages;
- **mutates pipeline state** (`item.doctorDisposition`/`doctorAttempts` + `saveState()`);
- **sends Telegram notifications** to the operator.

It is a remediation *dispatcher*, not a scan. None of those mutations record rollback ids in
the control-surface audit (the execute branch records only "doctor scan started"), so it also
fails the rollback-evidence bar. It stays review tier. If a genuinely read-only doctor
*report* endpoint appears later, that could be re-proposed — this endpoint cannot.

### 3.2 `start-job:service:mimule-overseer` / `mimule-orchestrator` — refused: unexecutable and evidence-free

The promotion premise was "restart-if-down … captures before/after service state in its job
output/audit". Two independent contradictions, either fatal alone:

1. **Neither service is in the execute allowlist.** `server/api/execute.ts:215-229` accepts
   only `ALLOWED_SERVICES`/`ALLOWED_CONTAINERS` (`server/api/actions.ts:15-19`:
   newsbites, newsbites-autopipeline, litellm, opencode-server, control-surface, vast-tunnel,
   cloudflared / openclaw_gateway, paperclip, goblin_game). `start-job:service:mimule-overseer`
   returns `{ ok: false, code: "ALLOWLIST" }` **every time**. Auto-promoting it would produce
   a guaranteed failure loop: failed audits → circuit breaker → flapping-insight noise.
2. **Even if allowlisted, the branch captures nothing.** It is an unconditional
   `execSync("systemctl restart " + targetId)` — not restart-if-down — creating **no job
   record** (`createJob` is never called on this path) and **no before/after service state**.
   The audit row says only "`<service> restarted`". That is exactly the "bypasses job
   records or captures nothing" case the spec says must not be promoted.

Both stay review tier. A future re-proposal needs: the services added to the allowlist
deliberately, an is-down precondition, and before/after `systemctl is-active` capture in a
job record — that is an execute-path change, out of SPEC-10 scope.

---

## 4. Structural rollback-evidence enforcement (code, not prose)

`server/insights/autoapplyPolicy.ts` now carries `AUTO_ROLLBACK_AFFORDANCES` — a declarative
map, keyed by `policyKeyForAction(actionId)`, living **next to** `SAFE_AUTO_ACTIONS` so
promotions and their rollback evidence are reviewed in one place:

| Auto-tier action (policy key) | Affordance | Evidence recorded |
|---|---|---|
| `start-job:model-health:all` | **read-only** (explicit marker) | Diagnostic probe; refreshes the model-health snapshot. Rollback is vacuous by design — restoring a stale snapshot would be anti-remediation. |
| `start-job:infra:doctor-log-rotate` | rollback | Timestamped `.jsonl.gz` archive path is in the audited result message; restore = gunzip back in place. |
| `mutate-policy:model:*:cooldown-clear` | rollback | Model id is in the audited actionId; compensating action `mutate-policy:model:<model>:block`. |
| `reasoner-remediate:pass-timeout` | rollback | Created run id(s) in audit `result_json.actionResult` and `reasoner_playbook_runs.result`; cancel via `POST /api/builder/runs/<runId>/cancel`. |

Enforcement in `server/insights/autoapply.ts` (`autoApplySafeInsights`): before an auto-tier
action executes, its affordance is resolved. **No entry → no execution**: the insight is
skipped with an audited row (`action_kind = 'insights.auto-apply'`,
`result_status = 'skipped'`, `result = 'autoapply.skipped-no-rollback'`) and left open for
operator review. The skip audit is deduped to one row per source key per 6 hours (the
scheduler ticks every 15 minutes; without dedupe a stuck finding would write ~96 identical
rows/day). `previewAutoApplyCandidates` reports the same verdict so the preview never
promises an apply the gate would refuse.

This is structural: if an operator force-promotes an arbitrary action to `auto` via the
policy tiers (`mutate-policy:autoapply:…:set-tier`), it still will not run unattended until
someone also declares its rollback affordance in code review. Tests cover the skip path, the
dedupe, preview parity, and that every current auto-tier action passes the gate.

---

## 5. Guardrails: untouched

`maxAutoAppliesPerHour = 10`, `circuitBreakerThreshold = 3` per `circuitBreakerWindowMs =
3,600,000` (1h), `minAiConfidenceForAutoApply = 0.75` — none changed in this review. A test
(`guardrail values are unchanged by SPEC 10`) pins the defaults, and the existing rate-limit,
circuit-breaker, and AI-confidence tests still pass unmodified. The promoted family runs
inside all three gates like every other auto action.

---

## 6. The 623 no-action findings are the real gap

The two biggest finding classes (`unregistered-ai-system`, `stuck-story` — 623 findings)
carry **no `actionDescriptorId`**. They cannot be auto-applied at any tier because there is
nothing to apply; no promotion policy can touch them. This is an **actions-coverage gap**
(ULTRAPLAN Phase 3 territory: registering discovered systems, unsticking stories as
first-class actions), not an auto-apply problem. Recording it here so the "auto-share"
number is never read as "the loop handles most findings" — most findings have no action yet.

---

## 7. Loop-stats measurement

### BEFORE baseline (live, read-only, 2026-07-05T22:45:54Z)

`GET /api/reasoner/loop-stats` on the live service (:3000):

```json
{
  "openCount": 0,
  "resolved7d": 46,
  "autoClosed7d": 6,
  "autoResolved7d": 3,
  "autoShare": 0.1956521739130435,
  "meanTimeToResolveMs": 46237501499,
  "recurrenceFlagged": 0
}
```

`GET /api/insights/auto-apply/preview` at the same moment: 2 open actionable candidates,
both review-tier (`start-job:doctor:scan`, `start-job:gateway:route-healthiest` families),
`wouldApply: false` for both — **zero auto-tier candidates were open at baseline**, and no
open pass-timeout finding existed at capture time.

### How the delta will show up (honest expectation — no number fabricated)

The live share delta **accrues as findings recur**; this session changes policy and
mechanism, not history, so no AFTER number exists yet and none is claimed.

- **Direct measure of this expansion** — auto-applied count:
  `SELECT COUNT(*) FROM action_audit WHERE action_kind = 'insights.auto-apply' AND
  result_status = 'success' AND ts >= <promotion-ts>;` (filter `request_json` on
  `"policyKey":"reasoner-remediate:pass-timeout"` to isolate the promoted family). At
  baseline the promoted family's contribution is necessarily 0.
- **The loop-stats tile** — Incidents page, "closed by the loop" tile
  (`app/routes/IncidentsPage.tsx`, fed by `/api/reasoner/loop-stats`). `autoShare` counts
  `incidents.auto-close` + `incidents.auto-resolve` over `resolved7d`. Pass-timeout
  auto-retries move it *indirectly*: a successful retried run clears the incident's
  condition, which lets the auto-close sweep close it without an operator.
- **What movement to expect** — pass-timeout was the largest actionable class (13 findings
  in the corpus window). When builder passes next time out, those findings should
  auto-apply (subject to the ≥0.75 AI-confidence gate and hourly budget) instead of waiting
  for review, so: auto-apply success rows > 0 within days of builder activity, and
  `autoShare` ticking up from ~0.20 as retried runs let their incidents auto-close. If
  builder activity is idle (as at baseline: `openCount 0`), the delta stays 0 — that is the
  metric being honest, not the mechanism failing.

---

## 8. Change inventory

- `server/insights/autoapplyPolicy.ts` — `PASS_TIMEOUT_RETRY_POLICY_KEY`, family default in
  `defaultTierForAction` (mirrors the cooldown-clear precedent), `AUTO_ROLLBACK_AFFORDANCES`
  + `rollbackAffordanceForAction`. `SAFE_AUTO_ACTIONS` unchanged (all three exact-id
  candidates were refused).
- `server/insights/autoapply.ts` — rollback-evidence gate + `autoapply.skipped-no-rollback`
  audit (deduped), preview parity, reasoner-remediate dispatch split in `runAutoApply`,
  audit rows now carry `actionResult` (run ids) + affordance + rollback hint.
- `server/insights/autoapply.test.ts` — 11 new tests: promoted-family tier resolution,
  refused ids stay review, affordance coverage, skip path + dedupe + preview, hermetic
  promoted-family apply, failed-dispatch audit, non-promoted family untouched, guardrail
  pin.
- This document.
