# Case Study: Closing the Autonomy Loop — a Real Flapper, Detected, Escalated, Fixed

**Period**: 2026-06-16 → 2026-07-06 (ongoing durability watch through ~2026-07-11)
**Outcome**: One real, recurring production defect went **detect → operator-Apply → escalate → root-cause → fix → verify** entirely through the control surface's own mechanisms, leaving a queryable audit chain end to end.

Every number below is either the result of a query run directly against the live database/API for this document, or is explicitly cited to a source document section. Where something could not be independently re-verified (because it describes the past, or because re-proving it live would require re-staging a real failure), that is stated plainly rather than assumed. See §9 to re-run every query yourself.

---

## 1. Executive summary

Between 2026-06-16 and 2026-07-04, the condition `[high/medium] Frontend changes not deployed` fired 11 separate times in `reasoner_incidents` — and every single time, the platform's own 7-day idle sweep quietly auto-resolved it before anyone looked at why it kept coming back. That is a "flapper": auto-remediation working exactly as designed, and in doing so masking a real defect. On 2026-07-03T11:48:11.864Z the platform's own recurrence detector (`detectRecurringIncidents()`) caught the pattern on its own and raised a high-severity ops insight. On 2026-07-05T14:23:25Z an operator applied that insight with a typed reason through the product's real Apply mechanism, which fired the product's real escalate action and created a builder workflow (two `action_audit` rows, ids `714769` and `714771`). The root cause — the sentinel's deploy-consistency check compared raw file mtimes instead of commit state, so it fired on ordinary uncommitted work, not just genuinely stuck deploys — was diagnosed from the sentinel's own source and fixed with a committed-vs-deployed signal, self-tested (5/5), and deployed with a pre-fix backup at 2026-07-05T14:30:33Z. Both escalated draft workflows were then closed through the workflow lifecycle API (`action_audit` ids `714780`–`714783`). As of this document's own queries (2026-07-06, ~06:45 UTC), zero new incidents of this exact condition have appeared since the fix deployed, and the routine 30-minute sentinel timer's most recent run (2026-07-06T06:22:53Z, not a staged probe) reports score 100, zero findings. Over the same week the platform-wide "closed by the loop" auto-share metric moved from 9.5% (2026-07-03) to 19.6% (my live fetch, 2026-07-06) — an honest, whole-system number, not a measurement of this one fix (§7 explains why).

## 2. The condition

A "flapper" is a defect that keeps recurring but never looks broken for long, because something else in the system keeps cleaning up after it. Here, `autoResolveStaleIncidents()` auto-resolves any incident with no recurrence in 7 days (recorded as `action_kind = "incidents.auto-resolve"`, result `auto-resolved`). That sweep is genuinely useful — most incidents really are one-off — but it cannot tell the difference between "this stopped because it's fixed" and "this stopped because the sweep just ran." Masking-detection is the hard part precisely because both cases produce an identical-looking `resolved` row; the only way to tell them apart is to count how often the *same* condition comes back inside a trailing window, which is what `detectRecurringIncidents()` does (≥3 incidents sharing `(failure_class, title)` within a 7-day window).

This specific flapper: the Product Health Sentinel's "Deploy consistency" check compared the newest mtime under `app/` to the newest built bundle file's mtime and failed if source looked more than 5 seconds newer. That fires on *any* edit to the frontend, committed or not — and this host's real workflow is hours of uncommitted work-in-progress before a commit, build, and restart. The sentinel runs every 30 minutes regardless of where in that cycle it lands, so it kept firing mid-session on ordinary work, not just on deploys that were actually stuck. The insight's own AI enrichment attached an unrelated, hallucinated root-cause guess — "Unregistered AI systems causing pipeline errors" — which I independently re-confirmed is still attached to the live insight record (`aiAnalysis.rootCause`, model `groq-llama-3-1-8b-instant`) as of my own fetch; it is flagged here explicitly so it is never mistaken for the real cause, which was diagnosed independently from the sentinel's source, not from that enrichment.

## 3. Timeline (all UTC, all verified against `reasoner_incidents` / `action_audit` / live queries)

| When | Event | Evidence |
|---|---|---|
| 2026-06-16 07:30:37 | 1st recorded occurrence of this exact condition | `reasoner_incidents` id `ri_0d0536f3-...` |
| 2026-06-17 10:00:55 | 2nd occurrence | `ri_e54f493f-...` |
| 2026-06-18 09:02:04 | 3rd occurrence | `ri_895a6c46-...` |
| 2026-06-25 10:03:45 | 4th occurrence | `ri_977a84c1-...` |
| 2026-06-27 23:16:41 | 5th occurrence | `ri_c93997d4-...` |
| 2026-06-28 21:47:37 | 6th occurrence | `ri_4cdf68f8-...` |
| 2026-06-29 10:17:55 | 7th occurrence | `ri_8f47049b-...` |
| 2026-06-30 00:18:48 | 8th occurrence | `ri_17b46bf8-...` |
| 2026-07-01 17:20:50 | 9th occurrence | `ri_c2705e49-...` |
| 2026-07-02 14:51:50 | 10th occurrence; escalated in an earlier proof to draft workflow `bw_e3c6d8ba-...` (created 2026-07-03 23:58:04) | `ri_6987c2ad-...` |
| **2026-07-03 11:48:11.864** | **Detection**: recurrence insight created — 6 occurrences inside the trailing 7-day window at that moment | `insights.created_at` for `insight_remediation_recurrence_..._frontend_changes_not_deployed`, confirmed live |
| 2026-07-04 02:22:46 → 18:52:49 | 11th (and, to date, latest) occurrence | `ri_00c3626a-9d2b-4a68-9e3b-8a3fc2a1a51c` |
| **2026-07-05 14:23:25** | **Operator Apply** with a typed reason fires the product's real escalate action, creating draft workflow `bw_62dab5f6-...` | `action_audit` ids `714769` (`incidents.escalate`) and `714771` (`insights.apply`), both `result_status=success` |
| 2026-07-05 (same session) | **Root cause** identified by reading the deployed sentinel's source, not by product enrichment | `docs/PROVING_CASE_FLAPPER.md` §4 |
| **2026-07-05 14:30:33.524** | **Fix deployed** to `/usr/local/bin/mimule-product-sentinel.py`, pre-fix backup taken first | file mtime confirmed by `stat`; backup sha256 confirmed by `sha256sum` (see §5) |
| 2026-07-05 14:36:20 → 14:36:32 | Both escalated draft workflows (`bw_62dab5f6-...`, `bw_e3c6d8ba-...`) closed via the workflow lifecycle API, `planFile` repointed to the proving-case doc | `action_audit` ids `714780`, `714781`, `714782`, `714783` |
| 2026-07-05 (same session) | **Live proof**: uncommitted WIP file created, sentinel run exactly as the timer runs it → `score=100 fails=0 warns=0`; `reasoner_incidents` count for this condition unchanged 11→11; forced insights scan → `sentinelIncidents: 0` | `docs/PROVING_CASE_FLAPPER.md` §7 (not re-staged here — the rails forbid manufacturing a real undeployed commit for this document) |
| **2026-07-06 06:22:53** | Routine (non-staged) sentinel timer run, one day after the fix: `score=100 fails=0 warns=0`, zero findings | `/var/lib/mimule/product-health.json`, read directly for this document |
| **2026-07-06 ~06:45–06:46** | This document's own queries: zero `reasoner_incidents` rows for this condition with `first_seen` after the fix's deploy time; live trailing-7-day count for the condition is **5**, down from 6 at detection; live loop-stats fetched | queries in §9, run for this document |

## 4. The audit chain

Every step above that mutated state left a row in `action_audit` that anyone with read access can query — not a log line, a structured row with an id, a kind, a result, and (where typed) the operator's own reason:

| id | ts (UTC) | action_kind | target | result_status |
|---|---|---|---|---|
| 714769 | 2026-07-05 14:23:25 | `incidents.escalate` | `ri_00c3626a-9d2b-4a68-9e3b-8a3fc2a1a51c` | success |
| 714771 | 2026-07-05 14:23:25 | `insights.apply` | `insight_remediation_recurrence_..._frontend_changes_not_deployed` | success |
| 714780 | 2026-07-05 14:36:20 | `builder.workflow.update` | `bw_62dab5f6-...` | success |
| 714781 | 2026-07-05 14:36:25 | `builder.workflow.lifecycle` | `bw_62dab5f6-...` | success |
| 714782 | 2026-07-05 14:36:32 | `builder.workflow.update` | `bw_e3c6d8ba-...` | success |
| 714783 | 2026-07-05 14:36:32 | `builder.workflow.lifecycle` | `bw_e3c6d8ba-...` | success |

Both `714769` and `714771` carry the identical, non-boilerplate reason text the operator typed at Apply time: *"P2.2 proving case: root-causing the deploy-consistency flapper — see docs/PROVING_CASE_FLAPPER.md"*. Rows `714780`–`714783` carry no free-text reason (the workflow-update/lifecycle actions don't take one), but their `target_id`s tie directly back to the two workflows this incident escalated to. The point of showing the raw ids and kinds rather than a narrated summary: this is not a story being told about the system — it is six rows a stranger can pull straight out of the database (§9 has the exact query).

## 5. Root cause + fix

The pre-fix deployed sentinel (`/usr/local/bin/mimule-product-sentinel.py`, check #4 "Deploy consistency," lines 236–249 per `docs/PROVING_CASE_FLAPPER.md` §4) compared the newest **file mtime** anywhere under `app/` to the newest built-bundle mtime and failed if source was more than 5 seconds newer — a signal that cannot distinguish "someone is mid-edit" from "a real deploy never happened." The fix, in the repo copy `ops/sentinel/mimule-product-sentinel.py` (`evaluate_deploy_consistency()`), replaces the raw mtime comparison with a committed-vs-deployed one: it reads the epoch of the last `git` commit that touched `app/` and compares *that* to the deployed bundle's mtime, with a named 15-minute grace period (`DEPLOY_GRACE_SECONDS`). Uncommitted work-in-progress no longer produces a finding at all (unless it goes stale for more than 24 hours, in which case it degrades to an informational warning, not a fail); a real committed-but-undeployed change still fails exactly as before. If `git` is unusable for any reason, the function honestly falls back to the old raw-mtime check rather than going silent. A `--self-test` mode (pure stdlib, writes only to its own temp directory, never touches the real `app/` tree) exercises five cases — fresh WIP, committed-not-deployed, deployed-after-commit, build-running, and no-git-repo — and the fix's own commit message and `docs/PROVING_CASE_FLAPPER.md` §6 report all five passing. The fix was deployed at 2026-07-05T14:30:33.524Z, after a pre-fix backup of the previously-deployed script was taken; I independently confirmed that backup's sha256 (`e3b96c08b87133d479081d56cdf82932a00e79550c53c4f271fc3d5352aa89d7`) matches exactly what the source document claims, by hashing the file on disk myself. (One inconsistency worth naming honestly: the backup file's own on-disk mtime reads 2026-06-12, not 2026-07-05 — most likely because the copy preserved the *original* deployed script's timestamp rather than stamping the moment of the backup; the content hash match is the stronger evidence of authenticity and it checks out exactly.)

## 6. Proof it stayed fixed

Two independent probes, one staged and one not, plus a direct query:

- **Staged, same day as the fix** (`docs/PROVING_CASE_FLAPPER.md` §7, not re-run for this document — re-staging a real undeployed commit is explicitly outside this document's read-only rails): an uncommitted WIP file was created and the sentinel run exactly as its timer runs it → `score=100 fails=0 warns=0`; the incident count for this condition was 11 before and 11 after (no new row); a forced insights re-scan reported `sentinelIncidents: 0`.
- **Not staged, one day later**: the sentinel's own routine 30-minute-timer run at 2026-07-06T06:22:53Z — real operating conditions, not a synthetic probe — reports `score: 100, fails: 0, warns: 0, findings: []`, read directly from `/var/lib/mimule/product-health.json` for this document.
- **Direct query, for this document**: zero `reasoner_incidents` rows for this exact `(failure_class, title)` with `first_seen` after the fix's deploy epoch (`1783262433000` = 2026-07-05T14:30:33Z), as of 2026-07-06 ~06:45 UTC.

The insight's own live-refreshed summary text (fetched for this document, not from any static doc) now reads *"...has produced 5 incidents in the last 7 days"* — down from 6 at detection time, which is exactly the expected trajectory as older occurrences age out of the 7-day window with no new ones added. **This is not yet the durability proof** — `docs/PROVING_CASE_FLAPPER.md` §9 lays out the honest criterion: the trailing-7-day count must drop below 3 starting ~2026-07-09 and reach 0 by ~2026-07-11. Today is 2026-07-06. The count falling from 6 to 5 is consistent with that trajectory holding, not confirmation that it has completed — that claim is deliberately not made here.

One terminal-state clarity worth stating plainly: the recurrence *insight* itself will stay `status: applied` forever (confirmed live for this document) and will **not** flip to `resolved` — `resolveStaleInsights()` only auto-resolves rows still `open`, and an operator-applied insight is intentionally terminal. The signal that the fix held is the incident table going quiet, not the insight status changing.

## 7. Before/after loop-stats

| Snapshot | When | resolved7d | autoClosed7d | autoResolved7d | autoShare |
|---|---|---|---|---|---|
| BEFORE (loop-stats feature's first boot) | 2026-07-03, recorded in `/opt/ai-vault/daily/2026-07-03.md` (commit `0f9e53d`) | 42 | 4 | — | ~9.5% |
| AFTER (this document's own live fetch) | 2026-07-06T06:46:17.421Z | 46 | 6 | 3 | 0.19565... (≈19.6%) |

**Honest attribution note (mandatory context, not a footnote):** this delta is a whole-system, whole-week number — `autoShare` is computed as `(incidents.auto-close count + incidents.auto-resolve count) / resolved7d` over a trailing 7-day window (verified directly in `server/api/reasoner.ts`), summed across **every** condition the platform tracks, not just this one. It moved because incidents across the whole system got auto-closed or auto-resolved during the week, not because of this flapper specifically. This flapper's own past incidents (all resolved via the idle sweep, `action_kind = incidents.auto-resolve`) did contribute historically to that numerator when they occurred — but going forward, since the fix means no *new* incidents of this condition exist to add to either the numerator or denominator, this case's future contribution to `autoShare` is zero by construction. The case's real, separate contribution is what §6 measures: the incidents stopped. Read the aggregate metric as corroborating context that the loop is working platform-wide, not as a measurement of this one fix.

## 8. What we deliberately did NOT claim

**(a) The insight did not "auto-resolve."** It shows `status: applied`, permanently, because `resolveStaleInsights()` is written to only ever touch insights that are still `open` — an operator-applied insight is correct, honest, terminal state, not a bug and not something worth disguising as an auto-resolve. The real signal that the fix worked is the incident table going quiet (§6), and this document does not conflate the two.

**(b) In this same phase, 3 of 4 additional planned auto-apply promotions were refused, not shipped.** Per `docs/AUTOAPPLY_PROMOTION_REVIEW.md` §3, the orchestrator planned to promote `start-job:doctor:scan` and two `start-job:service:*` restart actions to the unattended auto tier, then verified each against its actual implementation before deciding:
- `start-job:doctor:scan` was refused because it is **not** the read-only scan its premise assumed — the real handler requeues stuck stories into the live queue, sets model cooldowns, and mutates pipeline state, none of which is read-only or reversible.
- `start-job:service:mimule-overseer` and `start-job:service:mimule-orchestrator` were refused because neither service is in the execute allowlist (guaranteed failure loop if promoted) and, even if it were, the restart path captures no before/after state and creates no job record.

Only one promotion (`reasoner-remediate:pass-timeout:*`) actually shipped, and only after code verification confirmed it was genuinely non-destructive with a real rollback affordance. The frame that matters here: the system refuses to auto-apply actions it cannot evidence as safe — that refusal, recorded with reasons, is the same honesty discipline this case study is trying to model, not a shortfall to explain away.

## 9. Reproduce it yourself

Every number in this document can be re-derived with these exact, read-only commands.

**The audit chain (§4):**
```bash
sqlite3 "file:/var/lib/control-surface/dashboard.sqlite?mode=ro" -header -column "
SELECT id, datetime(ts/1000,'unixepoch') AS ts_utc, action_kind, target_id, result_status
FROM action_audit
WHERE id IN (714769, 714771, 714780, 714781, 714782, 714783)
ORDER BY id;"
```

**The full incident history for this condition (§2, §3):**
```bash
sqlite3 "file:/var/lib/control-surface/dashboard.sqlite?mode=ro" -header -column "
SELECT id, datetime(first_seen/1000,'unixepoch') AS first_seen_utc,
       datetime(last_seen/1000,'unixepoch') AS last_seen_utc, status
FROM reasoner_incidents
WHERE failure_class = 'sentinel_health'
  AND title = '[high/medium] Frontend changes not deployed'
ORDER BY first_seen;"
```

**The durable-fix watch — trailing-7-day recurrence count (§6; THE query to re-check over time):**
```bash
sqlite3 "file:/var/lib/control-surface/dashboard.sqlite?mode=ro" "
SELECT COUNT(*) AS n, datetime(MAX(last_seen)/1000,'unixepoch') AS latest
FROM reasoner_incidents
WHERE failure_class = 'sentinel_health'
  AND title = '[high/medium] Frontend changes not deployed'
  AND first_seen >= (strftime('%s','now') * 1000) - 7*24*60*60*1000;"
```
Expect this to fall below 3 starting ~2026-07-09 and to reach 0 by ~2026-07-11, with no row appearing at all after that if the fix has held.

**Confirm no new incidents since the fix deployed (§6):**
```bash
sqlite3 "file:/var/lib/control-surface/dashboard.sqlite?mode=ro" "
SELECT COUNT(*) FROM reasoner_incidents
WHERE failure_class = 'sentinel_health'
  AND title = '[high/medium] Frontend changes not deployed'
  AND first_seen > 1783262433000;" -- epoch for 2026-07-05T14:30:33Z, the fix's deploy time
```

**The insight's terminal status (§8a):**
```bash
sqlite3 "file:/var/lib/control-surface/dashboard.sqlite?mode=ro" "
SELECT id, status, created_at, resolved_at FROM insights
WHERE id = 'insight_remediation_recurrence_sentinel_health_high_medium_frontend_changes_not_deployed';"
```

**Live loop-stats (§7) — requires the operator token, read-only GET:**
```bash
TOKEN=$(grep -E '^OPERATOR_TOKEN=' /etc/control-surface/secrets.env | cut -d= -f2-)
curl -s -H "x-operator-token: $TOKEN" http://127.0.0.1:3000/api/reasoner/loop-stats
```

**The backup's authenticity (§5):**
```bash
sha256sum /root/control-surface-plans/backups/mimule-product-sentinel.py.pre-spec8
# expect: e3b96c08b87133d479081d56cdf82932a00e79550c53c4f271fc3d5352aa89d7
```

**The fix's deploy timestamp (§5):**
```bash
stat -c '%y' /usr/local/bin/mimule-product-sentinel.py
# expect: 2026-07-05 14:30:33
```

**The most recent routine sentinel run (§6):**
```bash
python3 -m json.tool < /var/lib/mimule/product-health.json
```
