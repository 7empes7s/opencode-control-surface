# Continuity Plan

**Version**: 1.0.0  
**Effective**: 2026-05-17  
**Owner**: Builder Platform Team

---

## Overview

This document defines the backwards compatibility policy, deprecation windows, and support tiers for the Builder Platform. It applies to all deployment modes: standalone (public API), embedded (internal routing), and hybrid deployments.

---

## Support Tiers

| Tier | Deployment Mode | Scope | SLA | Max Response Time |
|---|---|---|---|---|
| **GA** | Standalone + Embedded | v1.0 (`/v1/*`, `/api/*`) | 99.9% uptime | 24h business days |
| **Legacy** | Standalone only | v0.x deprecated endpoints | Best-effort | 5 business days |
| **Custom** | Embedded / white-label | Custom forks, modified routes | Per contract | Per contract |

GA tier is the default for all current features. Custom tier applies only when explicitly contracted.

---

## Backwards Compatibility Policy

### Embedded vs Standalone Parity

All routes under `/v1/` and `/api/` behave identically regardless of whether they are accessed via:
- Internal (embedded) URL — `http://localhost:18789/api/...`
- Public URL — `https://control.techinsiderbytes.com/api/...`

Response JSON shapes must be identical. Internal routes must not expose additional fields that public routes omit.

### Client SDK Compatibility

Clients built against v1.0 must continue to work without modification through the entire v1.x lifetime. This means:
- No silently breaking changes to response field types
- No removal of documented fields
- No change in HTTP status codes for the same request shape

### Embedded Mode Constraints

Embedded mode deployments (running behind the reverse proxy) must not introduce routes that bypass auth or alter behavior compared to standalone. Every auth check, rate limit, and response shape must match.

---

## Deprecation Windows

### Standard Deprecation

| Event | Notice Period | Communication |
|---|---|---|
| Route or field deprecation | Minimum 60 days | `X-API-Deprecation: true` header, changelog |
| Feature flag removal | 30 days | In-app banner, email to registered users |
| Entire API version (`/v1/`) | 12 months minimum | All of the above + migration guide |

### Early Warning Signals

When a route is deprecated but not yet removed:
- All responses include `X-API-Deprecated: <date>` header
- `DeprecationWarning` field appears in response body where applicable
- The [API Stability Policy](./api-stability.md) breaking change process applies

### Sunset Schedule

When a feature reaches end-of-life:
1. Responses include `X-API-Sunset: <date>` header
2. After sunset date, endpoint returns `410 Gone` with `{ error: "<feature> retired", migrationGuide: "/docs/operations/upgrade.md" }`
3. 30-day grace period: `410` responses include `Retry-After: 30` and `Retry-After` header

---

## Version Exit Criteria (v1.0 GA)

Before v1.0 was declared GA, the following were verified:

- [x] `GET /api/version` returns `{ version: "1.0.0", apiVersion: "v1" }`
- [x] `/v1/builder/workflows` alias forwards correctly to `/api/builder/workflows`
- [x] All routes return identical response shapes via internal vs public URL
- [x] Zero TypeScript errors in full test suite (`bun run typecheck`)
- [x] Production build passes with v1.0 badge visible
- [x] Rate limiting active on sensitive endpoints (30 req/min per IP)
- [x] HTTP boundary validation (method, content-type, body size) in place
- [x] Governance error paths return structured errors — no stack traces in responses
- [x] `docs/continuity-plan.md` created (this document)

---

## Review

This plan is reviewed quarterly and updated with each major version transition. Last reviewed: 2026-05-17.