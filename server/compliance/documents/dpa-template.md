# Data Processing Agreement

**Effective Date:** {{EFFECTIVE_DATE}}
**Customer:** {{CUSTOMER_NAME}}
**Tenant ID:** {{TENANT_ID}}

## 1. Parties

This Data Processing Agreement ("DPA") is entered into between the Service Provider ("Processor") and the Customer ("Controller").

## 2. Data Categories

The Processor shall process the following categories of personal data:
- User identifiers (email, name, subject)
- Access logs and audit trails
- API usage telemetry
- Session tokens and authentication data

## 3. Purpose

Processing is limited to providing the SaaS platform services, maintaining security, and generating compliance reports as requested by the Controller.

## 4. Retention Period

Personal data shall be retained for a maximum of {{RETENTION_DAYS}} days, after which it shall be securely deleted or anonymized.

## 5. Security Measures

The Processor implements:
- Encryption in transit (TLS 1.3)
- Encryption at rest (AES-256)
- Role-based access control (RBAC)
- Multi-factor authentication
- Regular security audits

## 6. Sub-processors

| Sub-processor | Purpose | Location |
|--------------|---------|-----------|
| LiteLLM | Local compute / inference | Local |
| OpenRouter | Cloud inference fallback | US/EU |
| Cloudflare | CDN / proxy | Global |
| Vast.ai | Optional GPU compute | Global |

## 7. Data Transfers

Data may be transferred to sub-processors in the following regions: US, EU. All transfers comply with applicable data protection laws.

## 8. Incident Notification

The Processor shall notify the Controller within 72 hours of discovering any personal data breach.

## 9. Audit Rights

The Controller has the right to request audit reports and compliance certifications annually.

## 10. Termination

This DPA remains in effect for the duration of the main service agreement. Upon termination, all personal data shall be returned or securely destroyed.

---
*Generated on {{GENERATED_DATE}} for tenant {{TENANT_ID}}*