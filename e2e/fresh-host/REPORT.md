# Fresh-Host Probe Report

Generated: 2026-07-06T13:13:42.057Z

## Verdict counts

| Verdict | Count |
|---|---|
| HONEST | 139 |
| LEAK | 1 |
| CRASH | 0 |
| ERROR-5xx | 0 |

Total endpoints probed: 140

## Endpoint results

| Route | Status | Verdict | ms | Detail |
|---|---|---|---|---|
| / | 200 | HONEST | 14 | len=458 |
| /api/actions/audit | 200 | HONEST | 16 | sourceStatus={} |
| /api/actions/catalog | 200 | LEAK | 130 | [{"needle":"vast","snippet":"k\",\"reasonerIncidents\":\"ok\",\"gpu\":\"ok\",\"vastBalance\":\"ok\",\"vastInstance\":\"ok\",\"pipel"},{"needle":"vast","snippet":"ts\":\"ok\",\"gpu\":\"ok\",\"vastBalance\":\"ok\",\"vastInstance\":\"ok\",\"pipeline\":\"ok\"},\"data\":{"}] |
| /api/admin/autofixes | 200 | HONEST | 2 | sourceStatus={} |
| /api/admin/briefing | 200 | HONEST | 5 | sourceStatus={} |
| /api/admin/events | 200 | HONEST | 2 | sourceStatus={} |
| /api/admin/health | 200 | HONEST | 4 | sourceStatus={} |
| /api/admin/search | 200 | HONEST | 2 | sourceStatus={} |
| /api/agent-registry | 200 | HONEST | 20 | sourceStatus={} |
| /api/agent-team | 200 | HONEST | 4 |  |
| /api/agents/discovery | 200 | HONEST | 16 |  |
| /api/agents/quick-prompts | 200 | HONEST | 5 |  |
| /api/agents/skills | 200 | HONEST | 5 |  |
| /api/agents/summary | 200 | HONEST | 1 |  |
| /api/agents/workspaces | 200 | HONEST | 1 |  |
| /api/approvals | 200 | HONEST | 2 |  |
| /api/audit/chain-status | 200 | HONEST | 4 | sourceStatus={} |
| /api/auth/status | 200 | HONEST | 1 |  |
| /api/autopipeline | 200 | HONEST | 2 | sourceStatus={"pipeline":"ok"} |
| /api/builder/artifacts | 400 | HONEST | 1 |  |
| /api/builder/discover | 400 | HONEST | 1 |  |
| /api/builder/doctor-reports | 200 | HONEST | 2 | sourceStatus={"builder":"ok"} |
| /api/builder/doctor/reports | 200 | HONEST | 1 | sourceStatus={"builder":"ok"} |
| /api/builder/log | 400 | HONEST | 1 |  |
| /api/builder/models | 200 | HONEST | 251 | sourceStatus={"builder":"ok","models":"ok"} |
| /api/builder/projects | 200 | HONEST | 2 | sourceStatus={"builder":"ok"} |
| /api/builder/runs | 200 | HONEST | 1 | sourceStatus={"builder":"ok"} |
| /api/builder/workflows | 200 | HONEST | 1 | sourceStatus={"builder":"ok"} |
| /api/channels | 200 | HONEST | 1 | sourceStatus={} |
| /api/claude/health | 200 | HONEST | 1 |  |
| /api/claude/sessions | 200 | HONEST | 1 |  |
| /api/cloud-tier/status | 200 | HONEST | 1 |  |
| /api/codex/sessions | 200 | HONEST | 0 |  |
| /api/compliance/dpa | 200 | HONEST | 1 | sourceStatus={} |
| /api/compliance/evidence-bundle | 200 | HONEST | 2 |  |
| /api/compliance/soc2-mapping | 200 | HONEST | 1 | sourceStatus={} |
| /api/compliance/subprocessors | 200 | HONEST | 1 | sourceStatus={} |
| /api/compliance/summary | 200 | HONEST | 1 | sourceStatus={} |
| /api/cost | 200 | HONEST | 124 |  |
| /api/cost/budgets | 200 | HONEST | 4 |  |
| /api/cost/fallbacks | 200 | HONEST | 2 |  |
| /api/cost/runway/vast | 200 | HONEST | 1 |  |
| /api/cost/spend | 200 | HONEST | 4 |  |
| /api/cost/summary | 200 | HONEST | 123 |  |
| /api/data-explorer/tables | 200 | HONEST | 4 | sourceStatus={} |
| /api/discovery/assets | 200 | HONEST | 1 | sourceStatus={} |
| /api/docs/tutorials | 200 | HONEST | 3 |  |
| /api/doctor | 200 | HONEST | 1 | sourceStatus={"doctor":"ok"} |
| /api/events | 200 | HONEST | 2 | sourceStatus={} |
| /api/feature-flags | 200 | HONEST | 1 | sourceStatus={} |
| /api/finance-intel/enrichments | 200 | HONEST | 1 | sourceStatus={} |
| /api/finance-intel/runs | 200 | HONEST | 1 | sourceStatus={} |
| /api/finance-intel/stats | 200 | HONEST | 2 | sourceStatus={} |
| /api/fs/browse | 200 | HONEST | 3 |  |
| /api/gateway | 200 | HONEST | 124 | sourceStatus={} |
| /api/gateway/keys | 200 | HONEST | 1 | sourceStatus={} |
| /api/gateway/ledger | 200 | HONEST | 1 | sourceStatus={} |
| /api/gateway/models | 200 | HONEST | 1 | sourceStatus={} |
| /api/gateway/showback | 200 | HONEST | 1 | sourceStatus={} |
| /api/gateway/stats | 200 | HONEST | 1 | sourceStatus={} |
| /api/gateway/status | 200 | HONEST | 122 | sourceStatus={} |
| /api/gemini/health | 200 | HONEST | 1 |  |
| /api/gemini/sessions | 200 | HONEST | 0 |  |
| /api/governance/approvals | 200 | HONEST | 0 |  |
| /api/governance/audit | 200 | HONEST | 1 |  |
| /api/governance/budgets | 200 | HONEST | 1 |  |
| /api/governance/policies | 200 | HONEST | 1 |  |
| /api/governance/rbac/me | 200 | HONEST | 1 |  |
| /api/governance/retention | 200 | HONEST | 0 |  |
| /api/governance/secrets | 200 | HONEST | 1 |  |
| /api/governance/users | 200 | HONEST | 1 |  |
| /api/home | 200 | HONEST | 117 | sourceStatus={"services":"ok","hetzner":"ok","pipeline":"ok","models":"ok","doctor":"ok","newsbites":"ok","vast":"error","opencode":"error"} |
| /api/incidents | 200 | HONEST | 2 | sourceStatus={} |
| /api/infra | 200 | HONEST | 19 | sourceStatus={"hetzner":"ok","vast":"error"} |
| /api/insights | 200 | HONEST | 3 | sourceStatus={} |
| /api/insights/auto-apply/preview | 200 | HONEST | 1 | sourceStatus={} |
| /api/install/status | 200 | HONEST | 6 | sourceStatus={} |
| /api/jobs | 200 | HONEST | 1 | sourceStatus={} |
| /api/licensing/status | 200 | HONEST | 1 |  |
| /api/litellm/config | 200 | HONEST | 1 |  |
| /api/litellm/routing | 200 | HONEST | 0 |  |
| /api/litellm/status | 200 | HONEST | 2 |  |
| /api/marketplace/skills | 200 | HONEST | 2 | sourceStatus={} |
| /api/metrics | 200 | HONEST | 3 | sourceStatus={} |
| /api/metrics/showcase | 200 | HONEST | 3 |  |
| /api/mission-control | 200 | HONEST | 106 |  |
| /api/models | 200 | HONEST | 43 |  |
| /api/models/routing-log | 200 | HONEST | 2 |  |
| /api/models/routing-stats | 200 | HONEST | 1 |  |
| /api/newsbites | 200 | HONEST | 5 | sourceStatus={"newsbites":"ok"} |
| /api/notifications/rules | 200 | HONEST | 1 | sourceStatus={} |
| /api/onboarding/status | 200 | HONEST | 15 |  |
| /api/orchestrator/instances | 200 | HONEST | 3 |  |
| /api/orchestrator/lanes | 200 | HONEST | 1 |  |
| /api/orchestrator/signals | 200 | HONEST | 1 |  |
| /api/paperclip/agents | 200 | HONEST | 3 |  |
| /api/paperclip/tasks | 200 | HONEST | 2 |  |
| /api/policy/registry | 200 | HONEST | 130 | sourceStatus={} |
| /api/product-health | 200 | HONEST | 1 | sourceStatus={"sentinel":"error"} |
| /api/projects | 200 | HONEST | 1 |  |
| /api/prompts | 200 | HONEST | 1 | sourceStatus={"prompts":"ok"} |
| /api/public-status | 200 | HONEST | 0 |  |
| /api/rbac/matrix | 200 | HONEST | 2 |  |
| /api/reasoner/diagnoses | 200 | HONEST | 0 | sourceStatus={"dashboardDb":"ok"} |
| /api/reasoner/incidents | 200 | HONEST | 1 | sourceStatus={"dashboardDb":"ok"} |
| /api/reasoner/jobs | 200 | HONEST | 0 | sourceStatus={"dashboardDb":"ok"} |
| /api/reasoner/loop-stats | 200 | HONEST | 0 | sourceStatus={"dashboardDb":"ok"} |
| /api/reasoner/playbooks | 200 | HONEST | 1 |  |
| /api/reports | 200 | HONEST | 1 | sourceStatus={} |
| /api/reports/templates | 200 | HONEST | 0 | sourceStatus={} |
| /api/scout/config | 200 | HONEST | 1 | sourceStatus={} |
| /api/scout/runs | 200 | HONEST | 1 | sourceStatus={} |
| /api/security/posture | 200 | HONEST | 7 | sourceStatus={} |
| /api/security/secrets | 200 | HONEST | 1 | sourceStatus={} |
| /api/security/trust-score | 200 | HONEST | 3 | sourceStatus={} |
| /api/settings/access | 200 | HONEST | 0 |  |
| /api/settings/auth-status | 200 | HONEST | 1 |  |
| /api/settings/state | 200 | HONEST | 0 |  |
| /api/setup/state | 200 | HONEST | 1 | sourceStatus={} |
| /api/sso/callback | 400 | HONEST | 1 |  |
| /api/sso/config | 200 | HONEST | 0 |  |
| /api/sso/login | 400 | HONEST | 1 |  |
| /api/sso/session | 200 | HONEST | 0 |  |
| /api/system-config | 200 | HONEST | 1 | sourceStatus={} |
| /api/system-config/history | 200 | HONEST | 0 | sourceStatus={} |
| /api/telemetry/preview | 200 | HONEST | 1 |  |
| /api/tenant/settings | 200 | HONEST | 0 | sourceStatus={} |
| /api/tenants | 200 | HONEST | 2 |  |
| /api/today | 200 | HONEST | 102 | sourceStatus={} |
| /api/traces | 200 | HONEST | 1 | sourceStatus={} |
| /api/traces/gateway | 200 | HONEST | 2 | sourceStatus={"traces":"ok"} |
| /api/v1/agents | 401 | HONEST | 1 |  |
| /api/v1/audit | 401 | HONEST | 1 |  |
| /api/v1/cost | 401 | HONEST | 1 |  |
| /api/v1/insights | 401 | HONEST | 0 |  |
| /api/v1/trust-score | 401 | HONEST | 1 |  |
| /api/version | 200 | HONEST | 1 |  |
| /api/webhooks | 200 | HONEST | 1 |  |
| /api/workload | 200 | HONEST | 2 | sourceStatus={} |
| /v1/models | 200 | HONEST | 2 |  |

## Container boot log (tail)

```
bun install v1.3.14 (0d9b296a)

Checked 256 installs across 303 packages (no changes) [10.00ms]
$ vite build
vite v5.4.21 building for production...
transforming...
✓ 2692 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                     0.46 kB │ gzip:   0.30 kB
dist/assets/index-CxFGGEev.css    185.45 kB │ gzip:  32.80 kB
dist/assets/index-BiMmwXgt.js   1,469.82 kB │ gzip: 375.99 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 5.44s
[control-surface] observability SQLite initialized
[control-surface] listening on :3000
[marketplace] Bundle 'echo' is unsigned — allowing with warning
[control-surface] echo skill auto-installed
[control-surface] dashboard ingestor started
[control-surface] builder reconciler started
[reasoner] watcher started
[gateway] editorial-heavy failed (unknown): Unable to connect. Is the computer able to access the url?
[insights-ai] enrichment failed Unable to connect. Is the computer able to access the url?
[gateway] editorial-heavy failed (unknown): Unable to connect. Is the computer able to access the url?
[insights-ai] enrichment failed Unable to connect. Is the computer able to access the url?
[gateway] circuit OPEN for editorial-heavy after 3 failures
[gateway] editorial-heavy failed (unknown): Unable to connect. Is the computer able to access the url?
[insights-ai] enrichment failed Unable to connect. Is the computer able to access the url?
[insights-ai] enrichment failed All models in chain for editorial-heavy are unavailable
[gateway] skipping editorial-heavy (circuit open)
```

## UI audit

Generated: 2026-07-06T13:15:11Z

Project: fresh-host-ui (chromium desktop) against http://localhost:4600

Total routes: 41 | PASS: 41 | FAIL: 0

| Route | Verdict |
|---|---|
| / | PASS |
| /status | PASS |
| /opencode | PASS |
| /codex | PASS |
| /claude | PASS |
| /gemini | PASS |
| /admin | PASS |
| /autopipeline | PASS |
| /insights | PASS |
| /security | PASS |
| /agents | PASS |
| /scout | PASS |
| /doctor | PASS |
| /models | PASS |
| /litellm | PASS |
| /newsbites | PASS |
| /infra | PASS |
| /incidents | PASS |
| /jobs | PASS |
| /agent-team | PASS |
| /audit | PASS |
| /today | PASS |
| /settings | PASS |
| /builder | PASS |
| /brainstorm | PASS |
| /governance | PASS |
| /traces | PASS |
| /gateway | PASS |
| /workflows | PASS |
| /projects | PASS |
| /about | PASS |
| /marketplace | PASS |
| /install | PASS |
| /cost | PASS |
| /finance-intel | PASS |
| /channels | PASS |
| /content-health | PASS |
| /reports | PASS |
| /data-explorer | PASS |
| /compliance | PASS |
| /feature-flags | PASS |
