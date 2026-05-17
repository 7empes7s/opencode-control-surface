# SOC2-Style Control Mapping

**Version**: 1.0.0

This document maps Builder Platform controls to the AICPA SOC 2 Trust Services Criteria (TSC). It is provided for informational purposes to support Customer compliance efforts.

---

## Criteria Categories

### CC1 — Control Environment

**CC1.1** — The entity demonstrates a commitment to integrity and ethical values.  
*Implementation*: Code of conduct in employee onboarding; all operators sign acceptable use policy; violations result in immediate revocation of access.

**CC1.2** — The entity demonstrates competence in the design and operation of specialized controls.  
*Implementation*: Platform developed and maintained by trained engineers; security reviews performed quarterly; incident post-mortems mandatory.

**CC1.3** — The board/executives demonstrate independence and oversight.  
*Implementation*: TechInsiderBytes is a small team; roles are segregated (no single person has end-to-end access to production + security controls).

**CC1.4** — The entity holds personnel accountable for internal control responsibilities.  
*Implementation*: RBAC with explicit role definitions; audit log of all actions; annual access review.

**CC1.5** — The entity evaluates and communicates internal control deficiencies.  
*Implementation*: Control deficiencies identified in post-mortems; communicated to affected customers within 72h if material.

---

### CC2 — Communication and Information

**CC2.1** — The entity internally communicates information including objectives and responsibilities.  
*Implementation*: Internal runbooks; on-call documentation; architecture diagrams reviewed annually.

**CC2.2** — The entity communicates with external parties regarding matters affecting the functioning of internal control.  
*Implementation*: Security announcements at `control.techinsiderbytes.com/security`; incident notifications within 72h; DPA available on request.

**CC2.3** — The entity internally communicates information to support the functioning of internal control.  
*Implementation*: Post-mortems documented; action items tracked; access review findings distributed to relevant teams.

---

### CC3 — Risk Assessment

**CC3.1** — The entity specifies objectives with sufficient clarity to enable identification of risks.  
*Implementation*: Security objectives defined in [Security Overview](./security-overview.md); reviewed annually.

**CC3.2** — The entity identifies risks to the achievement of objectives and analyzes risks.  
*Implementation*: Annual risk assessment; threat model documented; controls mapped to identified risks.

**CC3.3** — The entity assesses and monitors risk to the achievement of objectives.  
*Implementation*: Continuous monitoring via health checks (GPU tunnel every 60s, model health every 5h); alerts on anomalies; quarterly review.

**CC3.4** — The entity identifies and assesses changes that could significantly impact the control environment.  
*Implementation*: Any production change requires security review; major architectural changes trigger re-assessment.

---

### CC4 — Monitoring Activities

**CC4.1** — The entity selects and develops ongoing evaluations to ascertain whether internal control components are present and functioning.  
*Implementation*: Automated health checks for all critical services; manual penetration testing annually.

**CC4.2** — The entity evaluates and communicates deficiencies in internal control on a timely basis.  
*Implementation*: Deficiencies identified in monitoring are logged; severity determines response time (critical: 1h, high: 4h, medium: 24h, low: 7d).

---

### CC5 — Control Activities

**CC5.1** — The entity selects and develops control activities that mitigate risks to acceptable levels.  
*Implementation*: Control activities (encryption, RBAC, rate limiting, audit chain) designed to address identified risks; reviewed annually.

**CC5.2** — The entity deploys control activities through policies and procedures.  
*Implementation*: Security policies documented; enforced via code and configuration; deviations result in alerts.

**CC5.3** — The entity selects and develops general controls over technology.  
*Implementation*: Access to production systems restricted; changes require approval; logs retained for audit review.

---

### CC6 — Logical and Physical Access Controls

**CC6.1** — The entity implements logical access security measures.  
*Implementation*: Bearer token auth; RBAC; rate limiting; mTLS option for enterprise. See [Security Overview](./security-overview.md).

**CC6.2** — Prior to issuing access, the entity evaluates/approves requests.  
*Implementation*: New tenant access requires explicit action by tenant admin; access review performed annually.

**CC6.3** — Logical access security measures are implemented and maintained.  
*Implementation*: Tokens expire after 24h; session invalidation on logout; secret rotation supported.

**CC6.4** — Physical access controls are implemented and maintained.  
*Implementation*: Managed by Hetzner (EU data center); server located in locked cage; access logged.

**CC6.5** — The entity restricts access to sensitive data.  
*Implementation*: AES-256 at rest; secrets values never returned via API; RBAC restricts access to data by role.

**CC6.6** — The entity implements controls to prevent or detect unauthorized or malicious software.  
*Implementation*: Dependency scanning in CI; no arbitrary code execution; skill bundles signed and verified.

**CC6.7** — The entity restricts the ability to make configuration changes.  
*Implementation*: Production configuration managed via infrastructure-as-code; no direct console access to production systems.

**CC6.8** — The entity implements controls to prevent or detect and act on the introduction of unauthorized or malicious software.  
*Implementation*: CI/CD pipeline validates all changes; rollback capability for all deployments.

---

### CC7 — System Operations

**CC7.1** — The entity manages continuous operational availability.  
*Implementation*: GPU tunnel watchdog (60s restart); health check monitoring; incident response procedures; backups daily.

**CC7.2** — The entity manages batch jobs.  
*Implementation*: Batch jobs scheduled via cron; failure alerts; retry logic with exponential backoff; audit log of all runs.

**CC7.3** — The entity monitors system components.  
*Implementation*: Model health check every 5h; service health on `/api/home`; disk/memory monitored via `df -h` and `free -h`.

**CC7.4** — The entity protects against unauthorized or malicious software.  
*Implementation*: No arbitrary code execution; skill bundle sandboxing; no installation of untrusted software on production systems.

**CC7.5** — The entity maintains security controls.  
*Implementation*: Security patches applied within 30 days of release; critical patches within 72h; monitoring for regressions.

---

### CC8 — Change Management

**CC8.1** — The entity authorizes, designs, develops, configures, tests, approves, and deploys changes.  
*Implementation*: All changes go through code review; CI/CD pipeline; staging environment before production; rollback procedure documented.

**CC8.2** — The entity restricts unauthorized access to changes.  
*Implementation*: Production changes require admin role; no direct commits to production; access logged in audit chain.

---

### CC9 — Risk Mitigation

**CC9.1** — The entity identifies, selects, and develops risk mitigation activities.  
*Implementation*: Risk mitigation activities (encryption, backups, monitoring, rate limiting) designed and implemented; reviewed annually.

**CC9.2** — The entity monitors and maintains risk mitigation activities.  
*Implementation*: Continuous monitoring; quarterly review of control effectiveness; incidents trigger immediate review.

---

## Additional Controls (A1 — Availability)

**A1.1** — The entity maintains, monitors, and evaluates current processing capacity and use.  
*Implementation*: GPU tunnel health monitored every 60s; model health checked every 5h; capacity planning based on observed usage.

**A1.2** — The entity implements contingency plans to continue processing in the event of disruption.  
*Implementation*: GPU has manual fallback to cloud models if tunnel fails; backups restorable within 30min; incident response procedures documented.

---

## Control Effectiveness

The effectiveness of these controls is verified through:
- Annual internal security review
- Automated health and penetration tests
- Customer audit (enterprise tier)
- Third-party penetration testing (annual)

---

*Last reviewed: 2026-05-17*