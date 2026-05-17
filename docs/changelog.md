# Changelog

All notable changes to the OpenCode Control Surface are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-17

### Added

- **Stable v1 API** — All core endpoints are now versioned under `/api/v1/` with a published semver freeze policy. Breaking changes require a major version bump and 12-month deprecation window.

- **`GET /api/version`** — Returns version, build hash, commit, build time, node env, platform, and arch. Powers the v1 badge in the web UI.

- **`GET /api/home`** — Live telemetry dashboard: incident counts, GPU availability, newsbites site health, agent sessions, pipeline stage counts, and per-vertical digest for the last 5 minutes.

- **`GET /api/stream`** — Server-Sent Events endpoint for live updates to the operations dashboard without polling.

- **`GET /api/tenants`** — Multi-tenant tenant listing endpoint.

- **v1 prefix aliases** — `/v1/builder/`, `/v1/gateway`, `/v1/governance`, `/v1/licensing`, `/v1/telemetry`, `/v1/onboarding` forward to their `/api/` equivalents, providing a stable surface for external integrations.

- **Builder Workflows** — YAML-based multi-pass orchestration with `agentOrder`, `validationProfile`, `modelPolicy`, `riskPolicy`, `gitPolicy`, and `backupPolicy`. Supports scheduled (cron) and on-demand execution. Workflows are discovered, created, updated, and deleted via the REST API.

- **Gateway Model Routing** — Dynamic LiteLLM-backed model routing with health probes, fallback chains, cost ledger, per-model timeouts, and cloud burst when the local GPU is busy or unavailable.

- **Governance & Audit Chain** — Immutable audit log with structured error responses on every error path. Policy engine with configurable retention, SSO via OIDC, and data residency controls.

- **Reasoner (Auto-Repair)** — Anomaly detection with playbook-triggered auto-remediation. Tracks repair history and doctor review runs per workflow.

- **Reasoner Telemetry** — Consent-aware telemetry preview endpoint. Rate-limited at 30 req/min per IP.

- **Licensing Status** — License status endpoint for entitlement checking. Rate-limited at 30 req/min per IP.

- **Onboarding** — Multi-step operator onboarding flow. Rate-limited at 30 req/min per IP.

- **Incidents** — Cross-cutting failure timeline with per-incident actor, duration, resolution, and affected routes.

- **Infrastructure Monitor** — Hetzner VPS, Vast.ai GPU tunnel, and service health display (Caddy, cloudflared, newsbites, paperclip, openclaw/mimule, litellm, autopipeline, opencode-server, control-surface).

- **NewsBites Integration** — Article list, deploy history, site health for `news.techinsiderbytes.com`. Autopipeline stage visualization with per-stage timing and throughput metrics.

- **Models Panel** — Model inventory with health status, discovery (available Ollama/LiteLLM models), and GPU memory indicators.

- **Autopipeline Viewer** — Editorial queue with stage routing (cloud vs GPU), per-vertical auto-publish rules, and scout/brief generation status.

- **CLI (`builder`)** — Install script, environment configuration, workflow management commands, and doctor mode. Supports `BUILDER_HOST` and `BUILDER_TOKEN` env vars or `~/.builder/env` config file.

- **Web UI** — Responsive dashboard with live SSE stream, tenant/project context pills, incident severity badges, agent session timeline, GPU health sparklines, and dark-navy theme.

### Changed

- **API boundary hardening** — All `/api/*` routes now enforce method checks, Content-Type validation, and body size limits at the HTTP boundary before dispatch.

- **Rate limiting** — Sensitive endpoints (`/api/licensing/status`, `/api/telemetry/consent`, `/api/onboarding/step`) are rate-limited to 30 requests/minute per IP.

- **Error response structure** — All governance and API error paths now return structured `{ error: string, code?: string }` JSON responses with no stack traces.

### Documentation

- `docs/quickstart.md` — 5-minute install, configure, first workflow, run, and read results guide.
- `docs/concepts/builder.md` — Builder pillar: passes, plan files, agentOrder, continuation, doctor mode.
- `docs/concepts/gateway.md` — Gateway pillar: model routing, health probes, fallback chains, cost ledger.
- `docs/concepts/governance.md` — Governance pillar: audit chain, approvals, SSO, data residency, retention.
- `docs/concepts/reasoner.md` — Reasoner pillar: anomaly detection, playbooks, auto-remediation.
- `docs/reference/api.md` — Full HTTP API reference with all routes and request/response shapes.
- `docs/reference/cli.md` — CLI reference with install script flags and environment variables.
- `docs/reference/skill-manifest.md` — Skill bundle format, manifest schema, and signing.
- `docs/operations/backup-restore.md` — Backup policy, restore procedure, and DB migration guide.
- `docs/operations/upgrade.md` — Upgrade procedure, config migration, and rollback steps.
- `docs/operations/troubleshooting.md` — Common failure modes, log locations, and diagnostic commands.
- `docs/compliance/dpa.md` — Data Processing Agreement overview.
- `docs/compliance/security-overview.md` — Threat model, key controls, and audit chain.
- `docs/compliance/control-mapping.md` — SOC2-style control mapping.
- `docs/case-studies/newsbites-v4.md` — How the control surface built NewsBites V4.
- `docs/case-studies/tib-markets.md` — TIB Markets buildout with gateway routing and editorial pipeline integration.
- `docs/case-studies/self-bootstrapping.md` — Control surface building itself: dogfood loop, M1–M12 journey.
- `docs/api-stability.md` — v1 freeze policy, semver rules, and migration path for breaking changes.
- `docs/workflow-definition.md` — Frozen schema reference for workflow definition format.
- `docs/continuity-plan.md` — Backwards compatibility policy, deprecation windows, and support tiers.
- `examples/hello-builder/` — Minimal workflow example with one opencode pass and echo validation.
- `examples/scheduled-doctor/` — Nightly doctor review workflow with cron schedule.
- `examples/multi-agent-pipeline/` — 3-pass workflow: plan → build → review with fallback models.

### Migration from pre-v1

There are no breaking changes in v1.0.0 — this is the first stable release. All APIs were available as unstable `/api/*` endpoints prior to v1.0 and are now formally stabilized under `/v1/` aliases with a published compatibility guarantee.

If you are using raw `/api/*` paths directly, migrate to `/v1/*` aliases to lock into the stable surface. The `/api/*` paths remain functional but may change in future minor releases without notice.

---

## [0.x.x] — Pre-v1 (Internal)

Pre-v1 releases were internal-only and used to build the MIMULE / TechInsiderBytes stack. No compatibility guarantees apply to pre-v1 APIs.