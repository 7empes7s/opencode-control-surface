# Cold-Install Proof (SPEC 5 / ULTRAPLAN P0.5)

Generated: 2026-07-04T17:52Z

One documented command (`./install.sh`) taken from bare container to serving app shell,
with the first-run setup flow exercised end-to-end. Container: `oven/bun:1`, name
`cs-coldinstall`, `--memory 2g --cpus 2`, host port 4610 → 3000, removed after the run.

Source was a clean archive of the working tree (`git ls-files --cached --others
--exclude-standard` — tracked + new untracked files, no `node_modules`, no `dist`,
no `*.db`, no `.env`), i.e. exactly what a fresh `git clone` would deliver.

## Result: PASS

| Check | Result |
|---|---|
| Wall-clock, container start → `/` serving HTTP 200 (app shell/login) | **12.7 s** (budget: <10 min) |
| `bun install` inside bare container | 255 packages, 1.71 s — no native build steps |
| `bun run build` inside container | 5.36 s |
| `GET /api/setup/state` before completion | `{"needsSetup": true}` |
| `POST /api/setup/complete` without auth | **401** (denied, as required) |
| `POST /api/setup/complete` with operator token | `{"ok": true, "tenantName": "Acme Cold-Install Test"}` |
| `GET /api/setup/state` after completion | `{"needsSetup": false}` |
| Tenant renamed from seed default | `tenants[0].name = "Acme Cold-Install Test"` |
| Audit row written | `setup.complete`, risk `low`, result_status `success` |
| Re-run idempotency (container restart re-executes install.sh) | token **reused, not reprinted** ("already has an OPERATOR_TOKEN -- reusing it"); `/` back in 6.5 s; `needsSetup` stays `false` |

Timing detail: container started 2026-07-04T17:50:08.669Z; `/` returned 200 at
+12,668 ms (poll granularity 2 s, so true boot is ≤12.7 s). The `<10 min` assertion
passes with ~9.8 minutes to spare.

## Setup-flow transcript

```
=== GET /api/setup/state (BEFORE complete) ===
{
    "generatedAt": "2026-07-04T17:50:37.255Z",
    "sourceStatus": {},
    "data": {
        "needsSetup": true
    }
}

=== POST /api/setup/complete WITHOUT auth (must be denied) ===
HTTP 401

=== POST /api/setup/complete (authed, tenantName="Acme Cold-Install Test") ===
{
    "generatedAt": "2026-07-04T17:50:37.295Z",
    "sourceStatus": {},
    "data": {
        "ok": true,
        "tenantName": "Acme Cold-Install Test"
    }
}

=== GET /api/setup/state (AFTER complete) ===
{
    "generatedAt": "2026-07-04T17:50:37.325Z",
    "sourceStatus": {},
    "data": {
        "needsSetup": false
    }
}

=== tenant evidence (renamed from seed default) ===
{
  "tenants": [
    {
      "id": "mimule",
      "name": "Acme Cold-Install Test",
      "status": "active",
      "createdAt": 1783187417011,
      "updatedAt": 1783187437289,
      "projectCount": 1
    }
  ]
}

=== audit evidence (setup.complete, risk=low) ===
{
  "ts": 1783187437294,
  "action_kind": "setup.complete",
  "risk": "low",
  "target_type": "tenant",
  "target_id": "mimule",
  "result": "tenant renamed to \"Acme Cold-Install Test\"",
  "result_status": "success"
}

=== install.sh re-run (docker restart) — idempotency ===
[install.sh] /app/control-surface.env already has an OPERATOR_TOKEN -- reusing it (re-run is idempotent; token is not reprinted)
("Operator token generated" appears exactly once across both boots; env file mtime
and contents unchanged after the restart.)

=== setup state survives restart (completed marker persisted) ===
{
    "data": {
        "needsSetup": false
    }
}
```

## needsSetup design note (why it can never flip true on an existing install)

`needsSetup` is **not** an activity heuristic. The server autonomously writes rows
within seconds of every boot (ingestor → `metric_samples`, insights scanner →
`insights`, demo seeds → showcase tenants), so "does the DB contain rows?" cannot
distinguish a used install from a once-booted one — this was observed live in this
very proof before the design was corrected.

Instead, `migrateDashboardDb` writes a `setup.pending` marker (a `system_configs`
row) exactly once, at **database birth** — detectable only when the `tenants` table
is empty before seeding, which is never true for an existing database.
`needsSetup = pending marker present AND no completed marker AND seed tenant still
carries the literal seed-default name`. Verified against the live production DB
(read-only): no pending marker, tenant `MIMULE` → `needsSetup` computes **false**,
and a service restart cannot create the marker there (covered by
`server/api/setup.test.ts`).

## First-boot log (tail)

```
[install.sh] prerequisite check: bun=yes git=no curl=no
[install.sh] using existing checkout at /app
[install.sh] bun install
255 packages installed [1.71s]
[install.sh] bun run build
✓ built in 5.36s

=== Operator token generated ===
OPERATOR_TOKEN=<64-hex printed once; throwaway container credential>
Store this now -- it will not be printed again. It's saved (chmod 600) in /app/control-surface.env.

[install.sh] starting control surface on :3000 (foreground -- Ctrl+C to stop)
[control-surface] observability SQLite initialized
[control-surface] listening on :3000
[control-surface] dashboard ingestor started
[control-surface] builder reconciler started
[reasoner] watcher started
[gateway] editorial-heavy failed (unknown): Unable to connect. ...   <- honest degrade:
[insights-ai] enrichment failed ...                                      no model backends
[gateway] circuit OPEN for editorial-heavy after 3 failures              exist on a fresh host
```

## Notes

- `better-sqlite3` was removed from `package.json`: nothing imports it (the codebase
  uses `bun:sqlite` exclusively) and its `node-gyp` install script hard-fails in the
  bare `oven/bun:1` container (no Python), which blocked `bun install` — the direct
  blocker for this cold-install proof.
- The container was removed after this run (`docker rm -f cs-coldinstall`).
