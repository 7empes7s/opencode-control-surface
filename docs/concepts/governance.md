# Governance Pillar

**Version**: 1.0.0

---

## Overview

Governance is the security and compliance layer. It handles:
- **RBAC** (Role-Based Access Control) — who can do what
- **Approvals** — 4-eyes workflow for sensitive operations
- **Secrets management** — secure storage and rotation of credentials
- **Data retention** — how long data is kept and when it is purged
- **Audit chain** — tamper-evident log of all actions

---

## RBAC

Roles:
| Role | Description |
|---|---|
| `viewer` | Read-only access to dashboards and reports |
| `operator` | Can trigger actions, run workflows, view logs |
| `admin` | Full access including user management and SSO config |
| `owner` | Can delete the tenant and transfer ownership |

Roles are assigned per tenant. Default: the first user is `owner`.

Check your role:
```bash
curl -H "Authorization: Bearer $TOKEN" https://control.techinsiderbytes.com/api/governance/rbac/me
```

---

## 4-Eyes Approvals

For sensitive operations, a second operator must approve:

```yaml
riskPolicy:
  requireApprovalFor: ["deploy-production", "delete-resource"]
  approvalThreshold: "one"  # or "two"
```

When a workflow hits an approval-gated operation:
1. The run pauses and reports `status: pending_approval`
2. A notification is sent to eligible approvers
3. Any approver can `POST /api/approvals/<id>/approve`
4. If denied, the run is cancelled

Approvers are users with `admin` or `owner` role in the same tenant.

---

## Secrets Management

Secrets are stored encrypted and never exposed via API (only written/read internally).

```bash
# Write a secret
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"key": "OPENAI_API_KEY", "value": "sk-..."}' \
  https://control.techinsiderbytes.com/api/governance/secrets

# Read available secret keys (not values)
curl -H "Authorization: Bearer $TOKEN" \
  https://control.techinsiderbytes.com/api/governance/secrets

# Delete a secret
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://control.techinsiderbytes.com/api/governance/secrets/<key>
```

---

## Budget Enforcement

Set spending limits per tenant:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"monthlyBudgetMsat": 1000000, "alertAtPercent": 80}' \
  https://control.techinsiderbytes.com/api/governance/budgets
```

When the budget is exceeded, all AI requests are rejected with `403 Budget Exceeded`.

---

## Data Retention

Configure how long audit logs and artifacts are kept:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"auditLogsDays": 365, "artifactsDays": 90, "telemetryDays": 30}' \
  https://control.techinsiderbytes.com/api/governance/retention
```

After the retention period, data is automatically purged.

---

## Audit Chain

Every action is recorded in the audit chain. The chain is:
- **Append-only** — entries cannot be modified or deleted
- **Cryptographically chained** — each entry references the hash of the previous entry
- **Exportable** — via `GET /api/audit/export`

Verify chain integrity:
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://control.techinsiderbytes.com/api/audit/chain-status
```

---

## SSO (Optional)

For enterprise tenants, SSO can be configured via SAML 2.0. See [SSO Configuration](../reference/api.md#sso).

---

## Data Residency

All data is stored in the EU (`eu-west-1`) by default. Tenants requiring different residency should contact support.

---

## See Also

- [API Reference](../reference/api.md) — governance endpoints
- [Compliance](../compliance/security-overview.md) — security controls
- [Control Mapping](../compliance/control-mapping.md) — SOC2 control mapping