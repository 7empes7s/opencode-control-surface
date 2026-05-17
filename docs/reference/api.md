# HTTP API Reference

**Version**: 1.0.0 (frozen)  
**Base URL**: `https://control.techinsiderbytes.com`

All requests must include `Authorization: Bearer <token>` header unless noted.  
All responses are `Content-Type: application/json`.  
Error format: `{ error: string, code?: string, details?: unknown }`

---

## Auth

### GET /api/auth/status
Returns current auth state. No token required.

**Response**:
```json
{ "authenticated": boolean, "tenantId?: string, "role?: string }
```

### POST /api/auth/session
Create a session token.

**Request**: `{ "token": string }`

**Response**: `{ "ok": true, "token": string }`

---

## Builder

### GET /api/builder/projects
List all projects.

**Response**: `{ data: { id, name, path, lastRun }[] }`

### GET /api/builder/workflows
List all workflows.

**Response**: `{ data: { id, name, trigger, lastRun, status }[] }`

### POST /api/builder/workflows
Create a workflow.

**Request**: Workflow YAML as string in body.

**Response**: `{ id: string, name: string, createdAt: string }`

### GET /api/builder/workflows/:id
Get workflow details.

**Response**: `{ id, name, description?, agentOrder, trigger, createdAt, updatedAt }`

### PUT /api/builder/workflows/:id
Update a workflow.

**Request**: Workflow YAML as string.

**Response**: `{ ok: true }`

### DELETE /api/builder/workflows/:id
Delete a workflow.

**Response**: `{ ok: true }`

### POST /api/builder/workflows/:id/start
Start a workflow run.

**Response**: `{ runId: string, status: "running" }`

### POST /api/builder/workflows/:id/pause
Pause a running workflow.

**Response**: `{ ok: true, status: "paused" }`

### POST /api/builder/workflows/:id/resume
Resume a paused workflow.

**Response**: `{ ok: true, status: "running" }`

### POST /api/builder/workflows/:id/stop
Stop a running workflow.

**Response**: `{ ok: true, status: "stopped" }`

### POST /api/builder/workflows/:id/doctor-review
Trigger doctor review on current state.

**Response**: `{ ok: true, reportId: string }`

### GET /api/builder/runs
List recent runs. Query params: `?workflowId=&status=&limit=`

**Response**: `{ data: { id, workflowId, status, startedAt, finishedAt?, error? }[] }`

### GET /api/builder/runs/:id
Get run details.

**Response**: `{ id, workflowId, status, passes: [{ id, name, status, artifactPath? }], startedAt, finishedAt?, error? }`

### POST /api/builder/runs/:id/retry
Retry a failed run from the beginning.

**Response**: `{ runId: string, status: "running" }`

### POST /api/builder/runs/:id/cancel
Cancel a running run.

**Response**: `{ ok: true }`

### GET /api/builder/runs/:id/summary
Get a run summary (plan + pass results).

**Response**: `{ runId, workflowId, status, planProgress, passResults }`

### GET /api/builder/runs/:id/pass-live
SSE stream of live pass output.

**Response**: Server-Sent Events stream.

### GET /api/builder/doctor-reports
List doctor reports. Query: `?runId=&status=`

**Response**: `{ data: { id, runId, severity, findings, createdAt }[] }`

### GET /api/builder/artifacts
List artifacts. Query: `?path=&workflowId=&runId=`

**Response**: `{ data: { path, size, modifiedAt }[] }`

### GET /api/builder/log
Get artifact content. Query: `?path=`

**Response**: Raw text file.

---

## Gateway

### GET /api/gateway/status
Overall gateway health.

**Response**:
```json
{
  "status": "ok" | "degraded" | "error",
  "localModels": number,
  "cloudModels": number,
  "activeRequests": number
}
```

### GET /api/gateway/models
List all configured models with health status.

**Response**:
```json
{
  "data": [
    {
      "name": "gemma4:26b",
      "backend": "local",
      "status": "healthy" | "degraded" | "down",
      "latencyP50Ms": number,
      "errorRate": number
    }
  ]
}
```

### GET /api/gateway/ledger
Query cost ledger. Query: `?tenantId=&model=&from=&to=&limit=`

**Response**: `{ data: LedgerEntry[], total: number }`

### GET /api/gateway/stats
Live gateway statistics.

**Response**:
```json
{
  "requestsLastHour": number,
  "averageLatencyMs": number,
  "costMsatTotal": number,
  "models": ModelStats[]
}
```

### POST /v1/chat/completions
OpenAI-compatible chat completions.

**Request**:
```json
{
  "model": "gemma4:26b",
  "messages": [{ "role": "user", "content": "..." }],
  "temperature?: number,
  "max_tokens?: number
}
```

**Response**: OpenAI-compatible chat completion object.

### GET /v1/models
OpenAI-compatible models list.

**Response**:
```json
{
  "object": "list",
  "data": [{ "id": "gemma4:26b", "object": "model", "created": number, "owned_by": "local" }]
}
```

---

## Governance

### GET /api/governance/policies
List active governance policies.

**Response**: `{ data: Policy[] }`

### POST /api/governance/policies/reload
Reload policies from disk.

**Response**: `{ ok: true, loaded: number }`

### GET /api/governance/rbac/me
Get current user's RBAC info.

**Response**: `{ userId, tenantId, role, permissions: string[] }`

### GET /api/governance/approvals
List pending approvals for current user.

**Response**: `{ data: Approval[] }`

### POST /api/approvals/:id/approve
Approve a pending approval.

**Response**: `{ ok: true }`

### POST /api/approvals/:id/reject
Reject a pending approval.

**Response**: `{ ok: true }`

### GET /api/governance/secrets
List secret keys (not values).

**Response**: `{ data: string[] }`

### POST /api/governance/secrets
Write a secret.

**Request**: `{ "key": string, "value": string }`

**Response**: `{ ok: true }`

### DELETE /api/governance/secrets/:key
Delete a secret.

**Response**: `{ ok: true }`

### GET /api/governance/budgets
Get current budget settings.

**Response**: `{ monthlyBudgetMsat: number, alertAtPercent: number, currentSpendMsat: number }`

### POST /api/governance/budgets
Update budget settings.

**Request**: `{ "monthlyBudgetMsat": number, "alertAtPercent": number }`

**Response**: `{ ok: true }`

### GET /api/governance/retention
Get data retention settings.

**Response**: `{ auditLogsDays: number, artifactsDays: number, telemetryDays: number }`

### POST /api/governance/retention
Update retention settings.

**Request**: `{ "auditLogsDays": number, "artifactsDays": number, "telemetryDays": number }`

**Response**: `{ ok: true }`

### GET /api/audit/chain-status
Check audit chain integrity.

**Response**: `{ valid: boolean, lastEntryHash: string, entryCount: number }`

### POST /api/audit/export
Export audit log. Request: `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "format": "json" | "csv" }`

**Response**: `{ downloadUrl: string }`

---

## Licensing

### GET /api/licensing/status
Get license status.

**Response**:
```json
{
  "licensed": boolean,
  "plan": "free" | "pro" | "enterprise",
  "expiresAt?: string,
  "features": string[]
}
```

---

## Telemetry

### GET /api/telemetry/preview
Preview telemetry payload (no data sent).

**Response**: `{ payload: object, consentRequired: boolean }`

### POST /api/telemetry/consent
Set telemetry consent.

**Request**: `{ "consent": boolean }`

**Response**: `{ ok: true, consent: boolean }`

---

## Onboarding

### GET /api/onboarding/status
Get onboarding progress.

**Response**: `{ step: number, totalSteps: number, completed: boolean, stepName: string }`

### POST /api/onboarding/step
Advance onboarding step.

**Request**: `{ "step": number, "data": object }`

**Response**: `{ ok: true, nextStep: number }`

---

## Agents

### GET /api/agents/skills
List available skill bundles.

**Response**: `{ data: SkillBundle[] }`

### GET /api/agents/quick-prompts
List quick prompt templates.

**Response**: `{ data: QuickPrompt[] }`

### GET /api/agents/summary
System-wide agent summary.

**Response**: `{ opencode: AgentStatus, claude: AgentStatus, codex: AgentStatus }`

### GET /api/agents/discovery
Discover running agents.

**Response**: `{ data: AgentInstance[] }`

### GET /api/agents/workspaces
List agent workspaces.

**Response**: `{ data: Workspace[] }`

---

## Mission Control

### GET /api/mission-control
Aggregated system overview.

**Response**:
```json
{
  "services": ServiceStatus[],
  "gpu": GpuStatus,
  "autopipeline": AutopipelineStatus,
  "models": ModelHealthSummary,
  "incidents": IncidentSummary
}
```

---

## Health & Info

### GET /api/home
Dashboard landing data.

**Response**: `{ services, gpu, vast, hetzner, newsbites, autopipeline, doctor, models, incidents }`

### GET /api/version
Version info (NOT frozen — may change).

**Response**:
```json
{
  "version": "1.0.0",
  "buildHash": "abc123d",
  "apiVersion": "v1",
  "commit": "abc123d",
  "buildTime": "2026-05-17T...",
  "nodeEnv": "production",
  "platform": "linux",
  "arch": "x64",
  "updateAvailable": VersionInfo | null
}
```

### GET /api/doctor
Run diagnostics.

**Response**: `{ data: DiagnosticResult[] }`

### POST /api/doctor/scan
Trigger a manual diagnostic scan.

**Request**: `{ "service?: string" }`

**Response**: `{ scanId: string, status: "running" }`

---

## Error Codes

| Code | Meaning |
|---|---|
| `UNAUTHORIZED` | Missing or invalid token |
| `FORBIDDEN` | Valid token but insufficient role |
| `NOT_FOUND` | Resource does not exist |
| `VALIDATION_ERROR` | Request body failed validation |
| `RATE_LIMITED` | Too many requests |
| `BUDGET_EXCEEDED` | Monthly budget exceeded |
| `INTERNAL_ERROR` | Server error (details logged, not returned) |