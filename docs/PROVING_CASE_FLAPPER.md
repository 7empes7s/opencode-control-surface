# Proving Case: the `frontend-changes-not-deployed` flapper (ULTRAPLAN P2.2 / SPEC 8)

**Created**: 2026-07-05. **Companion to**: `MIMULE_MASTER_PLAN_V3.md` ULTRAPLAN P2.2,
`e2e/demo/BUILDER_DEMO.md` (same honesty format). Steps below are labeled **[PRODUCT MECHANISM]**
(the running control-surface's own escalate/insight/incident machinery, unmodified) or
**[ENGINEERING FIX]** (this task's code change, done outside the product because SPEC 8 IS
the engineering loop for this incident, not an autonomous Builder pass).

This is the closed-loop story for one recurring condition: `[high/medium] Frontend changes
not deployed`. It walks from the recurrence insight the product surfaced on its own, through
an operator Apply that used the product's real escalation mechanism, to the root-cause fix,
to live proof the fix works, to the honest durable-fix watch (§9) with a concrete date and
query for confirming the condition stays gone.

---

## Evidence table

| Step | Evidence | ID / value |
|---|---|---|
| Recurrence insight | `insights.id` | `insight_remediation_recurrence_sentinel_health_high_medium_frontend_changes_not_deployed` |
| Recurrence insight | source key | `remediation:recurrence:sentinel-health-high-medium-frontend-changes-not-deployed` |
| Recurrence count (at Apply time) | incidents in trailing 7 days | 6 (see incident table below) |
| Recurrence insight created | `insights.created_at` | 1783079291864 (2026-07-03T11:48:11.864Z) |
| Operator Apply | `action_audit.id` (`insights.apply`) | **714771** |
| Operator Apply | reason (typed, not boilerplate) | "P2.2 proving case: root-causing the deploy-consistency flapper — see docs/PROVING_CASE_FLAPPER.md" |
| Escalate action (fired by Apply) | `action_audit.id` (`incidents.escalate`) | **714769** |
| Escalation target | `actionDescriptorId` at Apply time | `escalate:incident:ri_00c3626a-9d2b-4a68-9e3b-8a3fc2a1a51c` |
| Escalated workflow | `builder_workflows.id` (**created, not reused** — see below) | `bw_62dab5f6-b933-4138-a14e-03ea24e743a0` |
| Escalated workflow plan file (product-generated) | path | `/var/lib/control-surface/incident-escalation-plans/ri_00c3626a-9d2b-4a68-9e3b-8a3fc2a1a51c-escalation.md` |
| Prior escalation (context, from an earlier proof) | `builder_workflows.id` | `bw_e3c6d8ba-187a-47ef-8727-b803d0ef06b9` (created 2026-07-03T23:58:04.373Z, escalated `ri_6987c2ad-...`) |
| Root cause | file:line (deployed script at the time) | `/usr/local/bin/mimule-product-sentinel.py:236-249` (check #4, "Deploy consistency"), `build_running` at line 114, `add()` at line 92 |
| Fix | repo file (new) | `ops/sentinel/mimule-product-sentinel.py` — `evaluate_deploy_consistency()` (lines 79-152), wired into check #4 at lines 470-475 |
| Fix commit | git hash | *(orchestrator fills in — this task made no commits per its rails)* |
| Pre-fix backup | path | `/root/control-surface-plans/backups/mimule-product-sentinel.py.pre-spec8` (sha256 `e3b96c08b87133d479081d56cdf82932a00e79550c53c4f271fc3d5352aa89d7`, taken 2026-07-05T14:30:24Z) |
| Deploy | `/usr/local/bin/mimule-product-sentinel.py` mtime | 2026-07-05T14:30:33Z (`stat -c %y`) |
| Self-test | `--self-test` exit code | 0 (5/5 PASS — see full output below) |
| Live proof | sentinel run with fresh uncommitted WIP | `score=100 fails=0 warns=0` (see below) |
| Live proof | `reasoner_incidents` row count for this condition, before vs. after | 11 / 11 (unchanged) |
| Live proof | forced `/api/insights/scan` after the probe run | `"sentinelIncidents": 0` |
| Workflow closure | `bw_62dab5f6-...` | `planFile` repointed to this doc, `lifecycleStatus` set to `done` |
| Workflow closure | `bw_e3c6d8ba-...` | same treatment (same root cause, now fixed — see rationale below) |
| Durable-fix watch | insight terminal state (operator-applied) | `applied` — auto-resolve only touches `open` insights (see §9) |
| Durable-fix watch | trailing-7-day incident count drops below 3 | starting ~2026-07-09, reaching 0 by ~2026-07-11 (see §9) |

---

## 1. Recurrence detected — [PRODUCT MECHANISM]

`server/reasoner/lifecycle.ts`'s `detectRecurringIncidents()` groups `reasoner_incidents` by
`(failure_class, title)` and flags any group with `n >= 3` incidents whose `first_seen` falls in
the trailing 7 days (`RECURRENCE_WINDOW_MS = 7 * DAY_MS`, `RECURRENCE_THRESHOLD = 3`). As of
2026-07-05, the `[high/medium] Frontend changes not deployed` condition had **6** incidents inside
that window:

| Incident | first_seen (UTC) | last_seen (UTC) | status |
|---|---|---|---|
| `ri_4cdf68f8-e7bc-42a3-8cb1-5b8960ffa4c6` | 2026-06-28 21:47:37 | 2026-06-28 23:17:45 | resolved (idle sweep) |
| `ri_8f47049b-43df-45ea-9125-229a38c88905` | 2026-06-29 10:17:55 | 2026-06-29 23:48:48 | resolved (idle sweep) |
| `ri_17b46bf8-9d03-4569-a7f8-207e82b726a3` | 2026-06-30 00:18:48 | 2026-06-30 01:18:48 | resolved (idle sweep) |
| `ri_c2705e49-799c-4a9e-a44b-37ff07dcbffe` | 2026-07-01 17:20:50 | 2026-07-01 17:20:50 | resolved (idle sweep) |
| `ri_6987c2ad-3362-4cfd-82d0-981a16cd0217` | 2026-07-02 14:51:50 | 2026-07-02 20:52:19 | resolved (idle sweep) — escalated to `bw_e3c6d8ba-...` |
| `ri_00c3626a-9d2b-4a68-9e3b-8a3fc2a1a51c` | 2026-07-04 02:22:46 | 2026-07-04 18:52:49 | resolved (idle sweep) — escalated to `bw_62dab5f6-...` (this proof) |

(Full history since 2026-06-25 is 11 distinct incidents for this condition; the recurrence insight
only counts the 7-day trailing window, which is 6 — matching the insight's own summary text
verbatim: *"...has produced 6 incidents in the last 7 days"*.)

Every one of these was auto-resolved by `autoResolveStaleIncidents()`'s 7-day idle sweep — never
by anyone fixing the underlying cause. That's exactly the "auto-close is masking a flapping root
cause" pattern `detectRecurringIncidents()` exists to catch, and exactly why it kept re-opening: a
condition that flaps and self-heals looks identical, from the incident table alone, to one that got
fixed — until you count how many times it comes back.

The insight's AI enrichment (`getAiAnalysis`, a small routing model) attached a **hallucinated,
unrelated** root-cause guess — *"Unregistered AI systems causing pipeline errors"* — worth flagging
explicitly so nobody downstream mistakes that for the real cause. The real root cause is below,
independently diagnosed from the sentinel script's source, not from that enrichment.

## 2. Operator Apply with a typed reason — [PRODUCT MECHANISM]

```
GET /api/insights?status=all   →  actionDescriptorId: escalate:incident:ri_00c3626a-9d2b-4a68-9e3b-8a3fc2a1a51c
POST /api/insights/insight_remediation_recurrence_sentinel_health_high_medium_frontend_changes_not_deployed/apply
  { "reason": "P2.2 proving case: root-causing the deploy-consistency flapper — see docs/PROVING_CASE_FLAPPER.md",
    "confirmed": true }
```

Result: `{"insight": {"status": "applied", ...}, "actionResult": {"ok": true, "action": "escalate",
"message": "incident ri_00c3626a-... escalated to draft workflow bw_62dab5f6-...", ...}}`

Two `action_audit` rows were written by this single Apply call (the insight-apply wrapper calls
`executeActionHandler` internally, which writes its own audit row for the underlying `escalate`
action, then the wrapper writes a second row for the `insights.apply` action itself):

- `id=714769` — `action_kind=incidents.escalate`, `action_id=escalate:incident:ri_00c3626a-...`,
  `result=success`, reason as above.
- `id=714771` — `action_kind=insights.apply`, `action_id=escalate:incident:ri_00c3626a-...`,
  `result=success`, reason as above.

**Reuse vs. new — the honest answer is NEW, not reuse.** `detectRecurringIncidents()` always points
the insight's `actionDescriptorId` at the *latest* incident in the recurring group (`MAX(last_seen)`),
not at whichever incident was escalated before. By 2026-07-05 the "latest" incident for this
condition was `ri_00c3626a-...` (first seen 2026-07-04), which had never been escalated —
`escalated_workflow_id` was `NULL` on that row. The escalate handler's idempotency check
(`server/api/execute.ts` lines 577-587) only short-circuits when the *specific* incident being
escalated already has an `escalated_workflow_id`; it has no concept of "this condition was already
escalated under a different incident id." So Apply legitimately created a **new** draft workflow,
`bw_62dab5f6-b933-4138-a14e-03ea24e743a0`, rather than resuming the older
`bw_e3c6d8ba-187a-47ef-8727-b803d0ef06b9` (which is still sitting there from an earlier proof,
escalated against `ri_6987c2ad-...`). This is a real, minor product gap — escalation idempotency is
per-incident, not per-condition — worth a follow-up ticket, but out of scope for this spec (no `app/`
or `server/` changes were made here). Both workflows are addressed in the workflow-closure section
below so neither is left as a stale forever-draft.

## 3. Escalated workflow — [PRODUCT MECHANISM]

`bw_62dab5f6-b933-4138-a14e-03ea24e743a0`, mode `once`, status `draft`, `maxPasses: 1`,
`gitPolicy: {commit: manual, push: never}` — the same idempotent escalate-to-workflow path SPEC 3
built (`escalate:incident` handler in `server/api/execute.ts`). Its plan file was generated at
`/var/lib/control-surface/incident-escalation-plans/ri_00c3626a-9d2b-4a68-9e3b-8a3fc2a1a51c-escalation.md`
and honestly states **no representative diagnosis was recorded** ("No representative diagnosis has
been recorded yet. Start from the evidence links below.") — there is no `reasoner_diagnoses` row
linked to this incident, so the escalation plan correctly declines to invent one. The real root
cause was independently diagnosed by reading the sentinel script's source (below), not seeded by the
product.

## 4. Root cause — file:line

`/usr/local/bin/mimule-product-sentinel.py` (the deployed copy, before this fix), check #4
("Deploy consistency", **lines 236-249**):

```python
src_m = newest_mtime([f"{APP_DIR}/app/**/*.tsx", f"{APP_DIR}/app/**/*.ts", f"{APP_DIR}/app/**/*.css"])
dist_m = newest_mtime([f"{APP_DIR}/dist/assets/*.js"])
if src_m and dist_m and src_m > dist_m + 5:
    if build_running:                      # build_running := bool(pgrep -f mimule-team), line 114
        add("undeployed", "Build in progress (changes not yet deployed)", "warn", ...)
    else:
        add("undeployed", "Frontend changes not deployed", "fail", ...)   # add() defined at line 92
```

This compares the newest **file mtime** anywhere under `app/` to the newest built bundle mtime. It
fires on *any* edit, committed or not. This host's actual workflow is: a builder agent edits `app/`
for 1-3 hours as uncommitted WIP, the orchestrator verifies the result, commits, and only *then*
builds and restarts. The sentinel runs every 30 minutes regardless of where in that cycle it catches
the repo, so it fires mid-session on ordinary uncommitted work, not just on genuinely stuck deploys.
`build_running` only suppresses the fail while `mimule-team` is actively running a build job — it does
nothing for the (much more common) case of a human/agent editing without a `mimule-team` process
attached. The check's *intent* — finished, committed changes must reach production — is correct;
the *signal* (raw mtime drift) was wrong for how this host works.

## 5. The fix — [ENGINEERING FIX]

New repo file `ops/sentinel/mimule-product-sentinel.py` (this task copied the deployed script in
verbatim first — confirmed byte-identical via `diff` — then edited it, so the diff against the
backup below is the actual, reviewable fix).

**New signal** (`evaluate_deploy_consistency()`, lines 79-152): committed-but-not-deployed. Uses
`git -C APP_DIR log -1 --format=%ct -- app/` to get the epoch of the **last commit that touched
app/**, compares that to `dist_m` with a **`DEPLOY_GRACE_SECONDS = 15 * 60`** grace period (line 61,
named constant with a comment) instead of the raw file mtime. If that commit is more than 15 minutes
newer than the deployed bundle and no build is running → same FAIL, same `"high"` severity, same
`fix_goal` text as before (this is still the genuine failure the check exists to catch).
Uncommitted WIP (source mtime newer than both the last commit and the bundle) produces **no finding**
unless it's gone stale (>24h old, still uncommitted → a `"wip-stale"` warn, no `fix_goal`, on the
theory that abandoned work deserves a nudge but fresh work-in-progress does not). The
`build_running` informational branch is unchanged. If `git` is unusable (not a repo, no commit has
ever touched `app/`, or the binary is missing), the function honestly falls back to the old raw-mtime
comparison rather than silently going blind.

**`--self-test`** (helpers + `run_self_test()` at lines 154-277, entry gate at line 276): builds a
throwaway git repo + `dist/assets/` fixture under
`tempfile.mkdtemp()` (Python's `mktemp -d` equivalent), sets file mtimes and commit timestamps
explicitly via `os.utime` / `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, and exercises:

- fresh uncommitted WIP → no finding (required case)
- committed but not deployed beyond the 15-min grace → fail (required case)
- deployed after the commit → no finding (required case)
- (bonus) same committed-not-deployed state while a build is running → warn only, never fail
- (bonus) no git repo at all → honest fallback to the old mtime comparison, still fails

It is pure stdlib (`subprocess`, `tempfile`, `shutil`, `os`), makes no network calls, writes nothing
outside its own tempdir (cleaned up via `shutil.rmtree` in a `finally` block), and never touches
`APP_DIR` — it calls the same `evaluate_deploy_consistency()` function the live check uses, but
against the throwaway fixture path, so there is exactly one implementation under test. The
`--self-test` gate (`if "--self-test" in sys.argv: run_self_test()`, line 276) runs and `sys.exit()`s
before any of the live-probe code (network session, sqlite, systemctl) below it executes.

## 6. Deploy

```
$ python3 -m py_compile ops/sentinel/mimule-product-sentinel.py     # OK
$ python3 ops/sentinel/mimule-product-sentinel.py --self-test        # 5/5 PASS, exit 0
$ cp /usr/local/bin/mimule-product-sentinel.py \
     /root/control-surface-plans/backups/mimule-product-sentinel.py.pre-spec8   # backup FIRST
$ cp ops/sentinel/mimule-product-sentinel.py /usr/local/bin/mimule-product-sentinel.py
$ chmod +x /usr/local/bin/mimule-product-sentinel.py
$ python3 -m py_compile /usr/local/bin/mimule-product-sentinel.py   # OK
```

Backup taken 2026-07-05T14:30:24Z, sha256 matches the pre-fix deployed script exactly
(`e3b96c08b87133d479081d56cdf82932a00e79550c53c4f271fc3d5352aa89d7`). Deployed copy's mtime:
2026-07-05T14:30:33Z. No `systemctl` call was made or needed — the 30-minute
`mimule-product-sentinel.timer` picks up the new file on its own next run.

### `--self-test` output

```
[product-sentinel --self-test]
  PASS  fresh WIP -> no finding
  PASS  committed-not-deployed beyond grace -> fail
  PASS  deployed after commit -> no finding
  PASS  build running -> informational warn only (bonus)
  PASS  no git repo -> mtime fallback still fails (bonus)
```
(exit code 0)

## 7. Prove it live — [PRODUCT MECHANISM] running [ENGINEERING FIX]'s new code

A scratch, comment-only, **uncommitted** file was created at `app/__spec8_wip_probe.tsx` (fresh
mtime, newer than both the last real commit and the deployed bundle — exactly the "normal working
state" the old check misfired on). The sentinel was then run **exactly as the timer runs it**:

```
$ python3 /usr/local/bin/mimule-product-sentinel.py
[product-sentinel] score=100 fails=0 warns=0 enqueued=0
```

`/var/lib/mimule/product-health.json` after the run: `"findings": []` — zero findings at all, not
even a `wip-stale` warn (the probe file is fresh, as expected). Before the run,
`reasoner_incidents` had **11** rows total for this condition (6 inside the trailing 7-day window,
listed above); after the run, still **11** — no new row was created. To rule out any doubt about
scan timing, the insights scan was also forced immediately afterward:

```
$ curl -s -X POST -H "x-operator-token: $TOKEN" http://127.0.0.1:3000/api/insights/scan
{ ..., "sentinelIncidents": 0, ... }
```

`runSentinelIncidentScan()` (`server/insights/scanners/sentinelIncidents.ts`) only creates
`reasoner_incidents` rows for `status: "fail"` findings in `product-health.json` — with zero
findings, it correctly created zero incidents. The probe file was then deleted
(`app/__spec8_wip_probe.tsx` no longer exists; `git status` on `app/` is clean), and the sentinel was
run once more to refresh `product-health.json` to the real, post-probe state (`score=100 fails=0
warns=0`, unchanged from the real baseline).

The committed-but-undeployed path was **not** re-proven against the live repo (the rails explicitly
forbid staging a real undeployed commit here) — it is proven exclusively via the `--self-test`
fixture case above ("committed-not-deployed beyond grace -> fail"), which exercises the identical
`evaluate_deploy_consistency()` function the live check calls.

## 8. Closing the workflow loop — [PRODUCT MECHANISM]

Both escalated draft workflows for this condition were updated via the existing Builder workflow
API (not by editing files on disk — `planFile` is a DB column the API happily repoints to a file
inside this repo):

```
PUT /api/builder/workflows/bw_62dab5f6-b933-4138-a14e-03ea24e743a0
  { ..., "name": "Escalated: [high/medium] Frontend changes not deployed — FIXED, see docs/PROVING_CASE_FLAPPER.md",
    "planFile": "/opt/opencode-control-surface/docs/PROVING_CASE_FLAPPER.md", ... }
POST /api/builder/workflows/bw_62dab5f6-b933-4138-a14e-03ea24e743a0/lifecycle
  { "lifecycle": "done" }

PUT /api/builder/workflows/bw_e3c6d8ba-187a-47ef-8727-b803d0ef06b9
  { ..., "name": "Escalated: [high/medium] Frontend changes not deployed — FIXED, see docs/PROVING_CASE_FLAPPER.md",
    "planFile": "/opt/opencode-control-surface/docs/PROVING_CASE_FLAPPER.md", ... }
POST /api/builder/workflows/bw_e3c6d8ba-187a-47ef-8727-b803d0ef06b9/lifecycle
  { "lifecycle": "done" }
```

Why both: the spec's own goal for this step is that "`/builder` should not show a stale
forever-draft for a fixed issue." `bw_e3c6d8ba-...` is exactly that — a draft escalation for the
*same* root cause, sitting open since 2026-07-03 from an earlier proof, and it would have stayed a
stale forever-draft indefinitely if only the brand-new workflow from step 2 were closed. Both now
point their `planFile` at this document (so opening either workflow's plan in the `/builder` UI
shows this proving-case story, not a generic auto-generated escalation stub) and both have
`lifecycleStatus` manually set to `done` via the workflow lifecycle action (`action_audit` ids
714780/714781 for `bw_62dab5f6-...`'s update+lifecycle calls, 714782/714783 for
`bw_e3c6d8ba-...`'s) — the only terminal value
the lifecycle API accepts for a draft (`new | in-progress | done | null`; there is no `canceled`
value at this layer, only on the granular `status` column, which `updateBuilderWorkflow` restricts to
`draft`/`ready` while editing — so `lifecycle: "done"` is the correct closing action here, not a
`status` change).

`config` itself was left untouched: `BuilderWorkflowConfig` has no free-text notes/description field
to point at a doc, so `planFile` is the only "plan/config" surface this API actually supports
repointing, and it is exactly the field the `/builder` UI reads when someone opens "view plan."

## 9. The watch — honest, no invented mechanism

**Correction found during orchestrator verification**: an earlier draft of this section projected
that the recurrence *insight* would flip to `resolved` via `resolveStaleInsights()` around
2026-07-09. That is not what will happen, because of an interaction between step 2 and the store:
the operator Apply in step 2 set the insight's status to **`applied`**, and
`resolveStaleInsights()` only ever auto-resolves rows `WHERE status = 'open'`
(`server/insights/store.ts:329-334`). `upsertInsight()` likewise preserves `applied` on re-scan
(only `resolved` flips back to open — `server/insights/store.ts:175-178`). So this insight's
**terminal state is `applied`** — which is the correct product semantics: auto-resolve exists for
conditions that stop on their own without an operator ever acting; this one was closed by an
operator action with a typed reason and an audit row.

The durable-fix watch is therefore the **incident count**, not the insight status.
`detectRecurringIncidents()` re-runs every 15 minutes and recomputes, per `(failure_class, title)`
group, how many incidents have `first_seen` inside the trailing 7-day window
(`RECURRENCE_WINDOW_MS = 7 * DAY_MS`, `RECURRENCE_THRESHOLD = 3`).

**Projected horizon, assuming no new recurrence** (the fix should ensure this — verified live
above): the 6 incidents inside the current window have `first_seen` timestamps of 2026-06-28 21:47,
2026-06-29 10:17, 2026-06-30 00:18, 2026-07-01 17:20, 2026-07-02 14:51, and 2026-07-04 02:22 (all
UTC). Walking the sliding 7-day cutoff forward: the count is still 6 on 2026-07-05, drops to 4 on
2026-07-06, stays at 3 through 2026-07-08, and drops to **2** — below threshold — once the cutoff
passes 2026-07-02 14:51, i.e. starting **2026-07-09**. From that point the condition is no longer
flagged as recurring, and with no new incidents the count falls to **0** by 2026-07-11.

**Fix-failure detection — where a regression would actually show up**: if the fix is wrong, new
`reasoner_incidents` rows for this condition appear (sentinel runs every 30 min) — visible on
`/incidents` and in the daily digest. Note that the recurrence *insight* will **not** re-open in
that case (upsert preserves `applied`), so do not watch the insight for regressions — watch the
incident table. That applied-but-still-recurring blind spot is a real, minor product gap
(candidate enhancement: re-open or re-create a recurrence insight when the count climbs again
after an apply), recorded here rather than papered over.

**Query to check the insight's (terminal) status at any time:**

```sql
sqlite3 /var/lib/control-surface/dashboard.sqlite "
SELECT id, status, resolved_at, resolution
FROM insights
WHERE id = 'insight_remediation_recurrence_sentinel_health_high_medium_frontend_changes_not_deployed';
"
```

Expected: `status='applied'`, indefinitely.

**Query to check the underlying trailing-7-day recurrence count directly** (same grouping
`detectRecurringIncidents()` uses — THIS is the durable-fix watch):

```sql
sqlite3 /var/lib/control-surface/dashboard.sqlite "
SELECT failure_class, title, COUNT(*) AS n, MAX(last_seen) AS latest, SUM(status='open') AS open_count
FROM reasoner_incidents
WHERE failure_class = 'sentinel_health'
  AND title = '[high/medium] Frontend changes not deployed'
  AND first_seen >= (strftime('%s','now') * 1000) - 7*24*60*60*1000
GROUP BY failure_class, title;
"
```

If this query returns **no row** (or `n < 3`) after 2026-07-09, falling to no row at all by
2026-07-11, the flapper is closed for good. If a new
incident for this exact condition appears *after* the fix was deployed (2026-07-05T14:30:33Z), that
is a genuine regression worth investigating from scratch — not evidence the fix didn't work, unless
it recurs on ordinary uncommitted WIP rather than a real undeployed commit.
