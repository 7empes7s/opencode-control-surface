# Security Overview

**Version**: 1.0.0

---

## Threat Model

The Builder Platform faces the following primary threat vectors:

### 1. Unauthorized Access
An attacker gains access to the API without a valid token.

**Controls**:
- Bearer token authentication on all mutating endpoints
- Token validation at the tenant boundary
- Failed login rate limiting (30 req/min per IP)
- mTLS option for enterprise tenants

**Mitigated by**: RBAC, rate limiting, token rotation

### 2. Data Exfiltration
An attacker or unauthorized user accesses sensitive data (workflow definitions, artifacts, secrets).

**Controls**:
- Secrets values never returned via API (only keys listed)
- Artifact access requires authentication
- Audit log of all access
- Encryption at rest (AES-256)

**Mitigated by**: Encryption, access controls, audit trail

### 3. Denial of Service
An attacker overwhelms the API with requests, preventing legitimate use.

**Controls**:
- Per-IP rate limiting (30–120 req/min depending on endpoint)
- `429 Too Many Requests` with `Retry-After` header
- No unbounded recursive operations
- GPU tunnel watchdog (60s intervals) restarts tunnel if unresponsive

**Mitigated by**: Rate limiting, circuit breakers, resource quotas

### 4. Injection / Manipulation
An attacker modifies workflow definitions or injects malicious content via prompts.

**Controls**:
- Workflow YAML validated before processing
- Agent prompts sandboxed per skill bundle permissions
- No arbitrary shell command execution (validationProfile.echo runs in constrained environment)
- RBAC prevents unauthorized workflow creation

**Mitigated by**: Validation, sandboxing, RBAC

### 5. Audit Log Tampering
An attacker modifies or deletes audit entries to conceal malicious activity.

**Controls**:
- Audit chain is append-only (no DELETE endpoint)
- Each entry cryptographically chained (SHA-256 hash of previous entry)
- Chain integrity verifiable via `GET /api/audit/chain-status`
- No operator can modify or delete individual entries

**Mitigated by**: Cryptographic chaining, append-only storage

---

## Key Security Controls

### Authentication & Authorization

| Control | Implementation |
|---|---|
| Bearer token auth | `Authorization: Bearer <token>` on all mutating endpoints |
| RBAC | Four roles: viewer, operator, admin, owner |
| Session management | Tokens expire after 24h; refresh via `POST /api/auth/session` |
| mTLS (optional) | Enterprise tenants can require client certificates |
| Token never in URL | Only in headers (prevents logging in URLs) |

### Encryption

| State | Method |
|---|---|
| In transit | TLS 1.2+ (enforced by Caddy) |
| At rest | AES-256 (SQLite, artifact files) |
| Secrets | Encrypted at rest; values never logged or returned via API |

### Audit Chain

Every API action is logged to the audit chain:
```typescript
interface AuditEntry {
  id: string;           // UUID
  timestamp: string;    // ISO 8601
  tenantId: string;
  userId: string;
  action: string;      // e.g., "workflow.create", "secret.write"
  resource: string;     // e.g., "/api/builder/workflows"
  method: string;       // HTTP method
  ip: string;
  userAgent: string;
  outcome: "success" | "failure";
  hash: string;         // SHA-256 of this entry + previous entry hash
}
```

The chain is append-only. Entries cannot be modified or deleted.

Verify chain integrity:
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://control.techinsiderbytes.com/api/audit/chain-status
# → { "valid": true, "lastEntryHash": "...", "entryCount": 12345 }
```

### Rate Limiting

| Endpoint | Limit | Window |
|---|---|---|
| `/api/gateway/models` | 120 req | 1 min |
| `/api/licensing/status` | 30 req | 1 min |
| `/api/telemetry/consent` | 30 req | 1 min |
| `/api/onboarding/step` | 30 req | 1 min |
| `/v1/chat/completions` | 120 req | 1 min |
| All others | 60 req | 1 min |

When exceeded: `429 Too Many Requests` with `Retry-After` header.

### Input Validation

All request bodies are validated before processing:
- JSON parse errors return `400 Bad Request`
- Schema validation on all mutating endpoints
- Body size limit: 1MB max (configurable)
- No stack traces in error responses (all errors return `{ error: string, code?: string }`)

---

## Security Monitoring

| Signal | Source | Alert threshold |
|---|---|---|
| Failed auth attempts | Audit log | >10 in 5 min per IP |
| Rate limit hits | Gateway | >50 in 10 min per IP |
| Service crash | systemctl | Any unexpected exit |
| GPU tunnel down | Health check | >3 consecutive failures |
| Model error rate | model-health.json | >5% error rate |
| Disk usage | df | >85% used |

---

## Incident Response

1. **Detect**: Alert received from monitoring
2. **Assess**: Determine severity and scope
3. **Contain**: Isolate affected component (stop service, revoke token)
4. **Remediate**: Fix root cause
5. **Notify**: Inform affected customers within 72h if data breach
6. **Post-mortem**: Document findings, update controls

---

## Compliance

The Builder Platform is designed to support:
- GDPR (EU data protection)
- EU-US Data Privacy Framework
- SOC 2 Type II controls (see [Control Mapping](./control-mapping.md))

---

## Security Announcements

Security-related announcements are posted at:  
`https://control.techinsiderbytes.com/security`

Subscribe by contacting `security@tib.com`.

---

*Last reviewed: 2026-05-17*