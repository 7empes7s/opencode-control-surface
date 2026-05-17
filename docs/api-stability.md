# API Stability Policy

**Version**: 1.0.0  
**Effective**: 2026-05-17  
**Owner**: Builder Platform Team

---

## Overview

The Builder Platform API is versioned under **semver** rules. Once a version prefix (`/v1/`) is declared stable, all routes under that prefix are frozen for the lifetime of the major version. This document defines what "frozen" means, how breaking changes are handled, and how to migrate when a breaking change is required.

---

## Version Lifecycle

| State | Semver | Support |
|---|---|---|
| Experimental | `0.x.y` | No guarantees. May break daily. |
| Stable | `1.x.y` | Freeze declared via `/v1/` prefix. Min 12 months support. |
| Deprecated | `2.0.0+` | `/v1/` still served but marked deprecated in response headers. |
| Retired | After next major | `/v1/` may return `410 Gone`. Minimum 6-month warning. |

---

## What is Frozen Under `/v1/`

All of the following are considered part of the v1 API surface and will not change in a breaking way:

- Route paths (exact match, not including aliases)
- HTTP methods
- Request body JSON shapes (field types, required vs optional)
- Response body JSON shapes
- Error response formats (`{ error: string, code?: string }`)
- Behavior of existing endpoints (idempotency, side effects)

**Aliases**: `/v1/builder/workflows` → `/api/builder/workflows` (same behavior, same frozen contract)

---

## What Can Change (Non-Breaking)

The following are explicitly allowed and do NOT constitute a breaking change:

- Adding new optional fields to request or response bodies
- Adding new routes under `/v1/` prefix
- Adding new query parameters (must be backward-compatible)
- Increasing rate limits or quotas
- Adding new enum values (clients must ignore unknown values)
- Performance improvements with no behavioral change
- Adding `X-RateLimit-*` headers

---

## Breaking Change Definition

A change is breaking if it would cause a **correctly-written v1 client** to fail or behave differently. Breaking changes include:

- Removing or renaming a route
- Removing or renaming a field in a request or response body
- Changing a field type (e.g., `string` → `number`)
- Making an optional field required
- Changing the meaning of a value (e.g., changing `status: "active"` semantics)
- Returning a different HTTP status code for the same condition
- Changing the required HTTP method

---

## Breaking Change Process

1. **Announce**: Minimum 60 days before breaking change lands, announce in:
   - Changelog entry with `[breaking]` tag
   - Email to registered API users (if applicable)
   - Header `X-API-Deprecation: true` on all v1 responses
2. **Migrate**: Provide a migration guide documenting exact before/after
3. **Rollout**: Breaking change only lands in a new major version (`/v2/`)
4. **Overlap**: New major version must overlap with old for minimum 12 months

---

## Migration Path for Breaking Changes

When `/v1/` reaches retirement:

1. A new prefix `/v2/` is opened with the new contract
2. `/v1/` responses include `X-API-Migrate-To: /v2/<path>` header
3. Clients are expected to update their path prefix within the deprecation window
4. After retirement, `/v1/` returns `410 Gone` with body: `{ error: "v1 retired", migrationGuide: "/docs/operations/upgrade.md" }`

---

## Error Format (Frozen)

All error responses from v1 endpoints conform to:

```typescript
interface ApiError {
  error: string;       // Human-readable message
  code?: string;      // Machine-readable error code
  details?: unknown;  // Additional context (optional)
}
```

Status codes:
- `400 Bad Request` — malformed request body
- `401 Unauthorized` — missing or invalid auth
- `403 Forbidden` — valid auth but insufficient permission
- `404 Not Found` — route does not exist (or resource not found)
- `429 Too Many Requests` — rate limit exceeded
- `500 Internal Server Error` — server-side error (stack trace NEVER exposed)

---

## Health & Version Endpoint

`GET /api/version` is excluded from the frozen contract — it may change at any time to reflect current build information.

---

## Review

This policy is reviewed quarterly. Last reviewed: 2026-05-17.