# SOC2 Control Mapping

This document maps SOC2 Trust Service Criteria to Platform controls.

| Criteria | Platform Feature | Implementation Notes |
|----------|-----------------|---------------------|
| CC6.1 Logical Access Controls | RBAC | Role-based access control in governance/rbac.ts; user-role bindings stored in governance_role_bindings table |
| CC6.2 User Registration & Authentication | SSO/OIDC | OIDC integration in server/sso/; session management via sso_sessions table; supports multiple providers |
| CC6.3 Access Enforcement | RBAC + Governance | Policy engine in server/governance/policy.ts; decisions logged in governance_policy_decisions table |
| CC6.4 Access Removal | Session expiration | SSO sessions expire automatically; manual logout endpoint in api/sso.ts |
| CC7.1 System Monitoring | Audit logging | All actions logged in action_audit table; chain hashing for tamper detection in governance/audit/export.ts |
| CC7.2 Anomaly Detection | Audit export + hash chain | Hash chain verification via verifyHashChain() ensures data integrity; export provides forensic capability |
| CC7.3 Incident Response | Incidents + Reasoner | Reasoner diagnoses failures; incidents tracked in reasoner_incidents table |
| CC8.1 Change Management | Marketplace + permissions | Skill installation requires permissions; workflow changes tracked via builder tables |
| CC8.2 Configuration Management | Builder + Doctor | Builder workflows validated by Doctor; configuration in builder_workflows table |
| CC9.1 Risk Assessment | Budgets + Policies | Budget limits in governance/budgets.ts; policies evaluated by policy engine |
| CC9.2 Oversight | 4-eyes approvals | Approval workflow in server/governance/approvals.ts; require_two_approvers flag in tenant_settings |
| CC9.3 Vendor Management | Subprocessors | This document lists all sub-processors; DPA generated for customers |

---
*Last Updated: 2026-05-17*
*Version: 1.0*