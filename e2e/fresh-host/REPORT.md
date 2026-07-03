# Fresh-Host Probe Report

Generated: 2026-07-03T19:57:15.627Z

## Verdict counts

| Verdict | Count |
|---|---|
| HONEST | 138 |
| LEAK | 1 |
| CRASH | 0 |
| ERROR-5xx | 0 |

Total endpoints probed: 139

## Endpoint results

| Route | Status | Verdict | ms | Detail |
|---|---|---|---|---|
| / | 200 | HONEST | 16 | len=458 |
| /api/actions/audit | 200 | HONEST | 12 | sourceStatus={} |
| /api/actions/catalog | 200 | LEAK | 133 | [{"needle":"vast","snippet":"ctor\":\"ok\",\"incidents\":\"ok\",\"gpu\":\"ok\",\"vastBalance\":\"ok\",\"vastInstance\":\"ok\",\"pipel"},{"needle":"vast","snippet":"ts\":\"ok\",\"gpu\":\"ok\",\"vastBalance\":\"ok\",\"vastInstance\":\"ok\",\"pipeline\":\"ok\"},\"data\":{"}] |
| /api/admin/autofixes | 200 | HONEST | 1 | sourceStatus={} |
| /api/admin/briefing | 200 | HONEST | 5 | sourceStatus={} |
| /api/admin/events | 200 | HONEST | 2 | sourceStatus={} |
| /api/admin/health | 200 | HONEST | 4 | sourceStatus={} |
| /api/admin/search | 200 | HONEST | 1 | sourceStatus={} |
| /api/agent-registry | 200 | HONEST | 21 | sourceStatus={} |
| /api/agent-team | 200 | HONEST | 3 |  |
| /api/agents/discovery | 200 | HONEST | 15 |  |
| /api/agents/quick-prompts | 200 | HONEST | 3 |  |
| /api/agents/skills | 200 | HONEST | 3 |  |
| /api/agents/summary | 200 | HONEST | 1 |  |
| /api/agents/workspaces | 200 | HONEST | 1 |  |
| /api/approvals | 200 | HONEST | 1 |  |
| /api/audit/chain-status | 200 | HONEST | 5 | sourceStatus={} |
| /api/auth/status | 200 | HONEST | 1 |  |
| /api/autopipeline | 200 | HONEST | 4 | sourceStatus={"pipeline":"ok"} |
| /api/builder/artifacts | 400 | HONEST | 1 |  |
| /api/builder/discover | 400 | HONEST | 1 |  |
| /api/builder/doctor-reports | 200 | HONEST | 1 | sourceStatus={"builder":"ok"} |
| /api/builder/doctor/reports | 200 | HONEST | 1 | sourceStatus={"builder":"ok"} |
| /api/builder/log | 400 | HONEST | 1 |  |
| /api/builder/models | 200 | HONEST | 248 | sourceStatus={"builder":"ok","models":"ok"} |
| /api/builder/projects | 200 | HONEST | 2 | sourceStatus={"builder":"ok"} |
| /api/builder/runs | 200 | HONEST | 1 | sourceStatus={"builder":"ok"} |
| /api/builder/workflows | 200 | HONEST | 1 | sourceStatus={"builder":"ok"} |
| /api/channels | 200 | HONEST | 1 | sourceStatus={} |
| /api/claude/health | 200 | HONEST | 1 |  |
| /api/claude/sessions | 200 | HONEST | 1 |  |
| /api/cloud-tier/status | 200 | HONEST | 2 |  |
| /api/codex/sessions | 200 | HONEST | 1 |  |
| /api/compliance/dpa | 200 | HONEST | 1 | sourceStatus={} |
| /api/compliance/evidence-bundle | 200 | HONEST | 4 |  |
| /api/compliance/soc2-mapping | 200 | HONEST | 2 | sourceStatus={} |
| /api/compliance/subprocessors | 200 | HONEST | 1 | sourceStatus={} |
| /api/compliance/summary | 200 | HONEST | 2 | sourceStatus={} |
| /api/cost | 200 | HONEST | 125 |  |
| /api/cost/budgets | 200 | HONEST | 2 |  |
| /api/cost/fallbacks | 200 | HONEST | 1 |  |
| /api/cost/runway/vast | 200 | HONEST | 1 |  |
| /api/cost/spend | 200 | HONEST | 2 |  |
| /api/cost/summary | 200 | HONEST | 123 |  |
| /api/data-explorer/tables | 200 | HONEST | 4 | sourceStatus={} |
| /api/discovery/assets | 200 | HONEST | 2 | sourceStatus={} |
| /api/docs/tutorials | 200 | HONEST | 4 |  |
| /api/doctor | 200 | HONEST | 1 | sourceStatus={"doctor":"ok"} |
| /api/events | 200 | HONEST | 2 | sourceStatus={} |
| /api/feature-flags | 200 | HONEST | 1 | sourceStatus={} |
| /api/finance-intel/enrichments | 200 | HONEST | 1 | sourceStatus={} |
| /api/finance-intel/runs | 200 | HONEST | 1 | sourceStatus={} |
| /api/finance-intel/stats | 200 | HONEST | 2 | sourceStatus={} |
| /api/fs/browse | 200 | HONEST | 2 |  |
| /api/gateway | 200 | HONEST | 124 | sourceStatus={} |
| /api/gateway/keys | 200 | HONEST | 1 | sourceStatus={} |
| /api/gateway/ledger | 200 | HONEST | 1 | sourceStatus={} |
| /api/gateway/models | 200 | HONEST | 2 | sourceStatus={} |
| /api/gateway/showback | 200 | HONEST | 1 | sourceStatus={} |
| /api/gateway/stats | 200 | HONEST | 0 | sourceStatus={} |
| /api/gateway/status | 200 | HONEST | 123 | sourceStatus={} |
| /api/gemini/health | 200 | HONEST | 2 |  |
| /api/gemini/sessions | 200 | HONEST | 1 |  |
| /api/governance/approvals | 200 | HONEST | 1 |  |
| /api/governance/audit | 200 | HONEST | 1 |  |
| /api/governance/budgets | 200 | HONEST | 2 |  |
| /api/governance/policies | 200 | HONEST | 1 |  |
| /api/governance/rbac/me | 200 | HONEST | 1 |  |
| /api/governance/retention | 200 | HONEST | 1 |  |
| /api/governance/secrets | 200 | HONEST | 1 |  |
| /api/governance/users | 200 | HONEST | 1 |  |
| /api/home | 200 | HONEST | 123 | sourceStatus={"services":"ok","hetzner":"ok","pipeline":"ok","models":"ok","doctor":"ok","newsbites":"ok","vast":"error","opencode":"error"} |
| /api/incidents | 200 | HONEST | 3 | sourceStatus={} |
| /api/infra | 200 | HONEST | 19 | sourceStatus={"hetzner":"ok","vast":"error"} |
| /api/insights | 200 | HONEST | 4 | sourceStatus={} |
| /api/insights/auto-apply/preview | 200 | HONEST | 1 | sourceStatus={} |
| /api/install/status | 200 | HONEST | 6 | sourceStatus={} |
| /api/jobs | 200 | HONEST | 1 | sourceStatus={} |
| /api/licensing/status | 200 | HONEST | 1 |  |
| /api/litellm/config | 200 | HONEST | 1 |  |
| /api/litellm/routing | 200 | HONEST | 0 |  |
| /api/litellm/status | 200 | HONEST | 4 |  |
| /api/marketplace/skills | 200 | HONEST | 1 | sourceStatus={} |
| /api/metrics | 200 | HONEST | 2 | sourceStatus={} |
| /api/metrics/showcase | 200 | HONEST | 2 |  |
| /api/mission-control | 200 | HONEST | 103 |  |
| /api/models | 200 | HONEST | 42 |  |
| /api/models/routing-log | 200 | HONEST | 0 |  |
| /api/models/routing-stats | 200 | HONEST | 1 |  |
| /api/newsbites | 200 | HONEST | 3 | sourceStatus={"newsbites":"ok"} |
| /api/notifications/rules | 200 | HONEST | 1 | sourceStatus={} |
| /api/onboarding/status | 200 | HONEST | 12 |  |
| /api/orchestrator/instances | 200 | HONEST | 1 |  |
| /api/orchestrator/lanes | 200 | HONEST | 0 |  |
| /api/orchestrator/signals | 200 | HONEST | 1 |  |
| /api/paperclip/agents | 200 | HONEST | 1 |  |
| /api/paperclip/tasks | 200 | HONEST | 1 |  |
| /api/policy/registry | 200 | HONEST | 129 | sourceStatus={} |
| /api/product-health | 200 | HONEST | 2 | sourceStatus={"sentinel":"error"} |
| /api/projects | 200 | HONEST | 1 |  |
| /api/prompts | 200 | HONEST | 1 | sourceStatus={"prompts":"ok"} |
| /api/public-status | 200 | HONEST | 2 |  |
| /api/rbac/matrix | 200 | HONEST | 0 |  |
| /api/reasoner/diagnoses | 200 | HONEST | 1 | sourceStatus={"dashboardDb":"ok"} |
| /api/reasoner/incidents | 200 | HONEST | 2 | sourceStatus={"dashboardDb":"ok"} |
| /api/reasoner/jobs | 200 | HONEST | 1 | sourceStatus={"dashboardDb":"ok"} |
| /api/reasoner/loop-stats | 200 | HONEST | 1 | sourceStatus={"dashboardDb":"ok"} |
| /api/reasoner/playbooks | 200 | HONEST | 1 |  |
| /api/reports | 200 | HONEST | 1 | sourceStatus={} |
| /api/reports/templates | 200 | HONEST | 0 | sourceStatus={} |
| /api/scout/config | 200 | HONEST | 1 | sourceStatus={} |
| /api/scout/runs | 200 | HONEST | 2 | sourceStatus={} |
| /api/security/posture | 200 | HONEST | 10 | sourceStatus={} |
| /api/security/secrets | 200 | HONEST | 1 | sourceStatus={} |
| /api/security/trust-score | 200 | HONEST | 4 | sourceStatus={} |
| /api/settings/access | 200 | HONEST | 2 |  |
| /api/settings/auth-status | 200 | HONEST | 1 |  |
| /api/settings/state | 200 | HONEST | 1 |  |
| /api/sso/callback | 400 | HONEST | 1 |  |
| /api/sso/config | 200 | HONEST | 0 |  |
| /api/sso/login | 400 | HONEST | 1 |  |
| /api/sso/session | 200 | HONEST | 1 |  |
| /api/system-config | 200 | HONEST | 0 | sourceStatus={} |
| /api/system-config/history | 200 | HONEST | 1 | sourceStatus={} |
| /api/telemetry/preview | 200 | HONEST | 0 |  |
| /api/tenant/settings | 200 | HONEST | 1 | sourceStatus={} |
| /api/tenants | 200 | HONEST | 0 |  |
| /api/today | 200 | HONEST | 98 | sourceStatus={} |
| /api/traces | 200 | HONEST | 2 | sourceStatus={} |
| /api/traces/gateway | 200 | HONEST | 1 | sourceStatus={"traces":"ok"} |
| /api/v1/agents | 401 | HONEST | 1 |  |
| /api/v1/audit | 401 | HONEST | 0 |  |
| /api/v1/cost | 401 | HONEST | 1 |  |
| /api/v1/insights | 401 | HONEST | 0 |  |
| /api/v1/trust-score | 401 | HONEST | 0 |  |
| /api/version | 200 | HONEST | 1 |  |
| /api/webhooks | 200 | HONEST | 1 |  |
| /api/workload | 200 | HONEST | 1 | sourceStatus={} |
| /v1/models | 200 | HONEST | 1 |  |

## Container boot log (tail)

```
bun install v1.3.14 (0d9b296a)

Checked 295 installs across 338 packages (no changes) [43.00ms]
$ vite build
vite v5.4.21 building for production...
transforming...
✓ 2692 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                     0.46 kB │ gzip:   0.30 kB
dist/assets/index-CxPwPnIS.css    185.26 kB │ gzip:  32.77 kB
dist/assets/index-D_q99XtM.js   1,456.68 kB │ gzip: 372.79 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 5.35s
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
