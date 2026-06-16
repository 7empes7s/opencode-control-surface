# **BRAINSTORMER FEATURE — MASTER PLAN V1**

---

## **1. Purpose & Product Vision**

### **What is Brainstormer?**  
Brainstormer is a multi-pass AI planning engine embedded within the **BuilderOS** platform, accessible via a new tab in the **BuilderPage**. It transforms a user’s raw idea — expressed in plain language — into a structured, vetted software development plan, culminating in an auto-generated Builder workflow that can be launched later.

The system executes a sequence of AI-driven “passes” (e.g., Architect, UX Designer, Security Analyst), each role-playing a specialist to iteratively refine the idea. After 5–8 passes, two final deliverables are produced:

- `PLAN_V1.md`: High-level feature plan (non-technical)
- `PLAN_V2.md`: Technical specification with agentOrder sequences, validation rules, and git/risk policies
- `SUMMARY.md`: Concise success criteria and confidence score

From there, the user can click “Create Builder Run” to generate a draft workflow — **never auto-launched**.

---

### **Who is it for?**  
Primary users are **non-technical business owners** who have product ideas but lack coding or systems design skills. They need guided, jargon-free interaction with AI specialists to translate vision into executable plans.

Secondary users include technical leads who review plans before handoff.

---

### **Why build it?**  
To **democratize software creation** by abstracting complexity into a conversational, AI-guided journey. It reduces the cognitive load of initiating a Builder workflow and increases success rates by pre-validating plans.

---

### **Success Metrics**
| Metric | Target |
|-------|--------|
| % of sessions reaching `done` status | ≥ 85% |
| Avg. time from intake to plan ready | ≤ 90s |
| % of generated workflows that pass validation | ≥ 90% |
| User-reported clarity of plan output | ≥ 4.2/5 |
| Concurrent sessions per tenant | ≤ 2 (enforced) |

---

### **Fit within BuilderOS**  
Brainstormer sits **alongside** the existing Builder tab as an additive feature. It does **not** alter existing functionality. It leverages:

- Existing auth (`checkToken`)
- Existing Builder workflow schema (`BuilderWorkflowInput`)
- Existing design tokens and form components
- LiteLLM proxy (`http://127.0.0.1:4000`) and OpenCode CLI

It enhances the “idea-to-execution” funnel by adding a **pre-build planning layer**.

---

## **2. User Journey**

### **Step 1: Enter Brainstorm Tab**
- User clicks “Brainstorm” tab in BuilderPage
- If no sessions exist: `IntakeForm` is shown
- If sessions exist: `SessionList` shown with latest at top

---

### **Step 2: Intake Form**
User fills:
- **Name** (e.g., “Customer Feedback Widget”)
- **Description** (e.g., “Let users rate articles with 1–5 stars”)
- **Optional Specs** (e.g., “Must work on mobile, connect to Supabase”)

→ Clicks “Start Planning”

→ System creates session, redirects to `SessionView`

---

### **Step 3: Pass Configuration Panel**
Before planning begins:
- Smart recommendation overlay suggests pass count based on description length and keywords
- Slider allows user to adjust `target_passes` (3–8, default 6)
- Confidence bar shows initial `N/A` state
- Model labels show `free` (e.g., `ollama/phi3`)

---

### **Step 4: Planning Execution (SSE-Driven)**
User sees:
- **PassTimeline**: Vertical list of 8 passes (Architect → UX → Backend → Critic → Security → V1 → V2 → Summary)
- Each `PassCard` shows:
  - Role icon + name
  - Status pill: `.pill.gray` → `.pill.amber` → `.pill.green`
  - Model label (e.g., `.pill.mono: llama3:8b`)
  - Estimated duration (5–20s)
- **PlanningHealthIndicator**: Pulse animation during active pass
- **ConfidenceBar**: Updates after each pass (0% → 100%)

After each pass completes:
- SSE emits `pass_completed` → UI updates
- Optional `user_message_injected` events update timeline
- If user sends message: `UserMessageInput` appends to timeline with `You:` badge

---

### **Step 5: Plan Ready**
When all passes complete:
- `PLAN_V1.md` and `PLAN_V2.md` appear in `PlanPreview` (`.markdown` class)
- `SummaryView` shows confidence score, risk flags, and key assumptions
- `BuilderRunCreationPanel` appears with “Create Builder Run” button
- Button disables after click, shows “Creating…”
- On success: toast + “View in Builder” link

---

### **Smart Guidance Triggers**
| Element | When Shown | Content |
|--------|------------|--------|
| **SmartRecommendationOverlay** | Hover on recommended pass count | “Based on complexity, we suggest 6 passes to ensure security and UX are reviewed.” |
| **ConfidenceBar** | During/after each pass | Color: red (<50%), amber (50–80%), green (>80%) |
| **ModelLabel** | On each pass card | Color-coded: green (free), amber (fallback paid), red (error) |
| **HealthIndicator** | While pass running | Pulsing dot + “AI thinking…” |

---

## **3. Data Architecture**

### **SQLite Schema**

```sql
-- Brainstorm session metadata
CREATE TABLE brainstorm_sessions (
    id TEXT PRIMARY KEY CHECK(id GLOB '[a-zA-Z0-9_-]+'),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
    description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
    specs TEXT CHECK(specs IS NULL OR length(specs) <= 8000),
    status TEXT NOT NULL DEFAULT 'intake' CHECK(status IN ('intake','configuring','ready','running','paused','done','failed','canceled','interrupted')),
    model_tier TEXT NOT NULL DEFAULT 'free' CHECK(model_tier IN ('free','paid')),
    recommended_passes INT CHECK(recommended_passes BETWEEN 3 AND 8),
    target_passes INT NOT NULL DEFAULT 6 CHECK(target_passes BETWEEN 3 AND 8),
    completed_passes INT DEFAULT 0 CHECK(completed_passes >= 0),
    plan_v1_path TEXT,
    plan_v2_path TEXT,
    summary_path TEXT,
    workflow_id TEXT,
    complexity_score REAL CHECK(complexity_score BETWEEN 0.0 AND 1.0),
    cancel_requested INT DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    tenant_id TEXT NOT NULL,
    created_at INT NOT NULL,
    updated_at INT NOT NULL
);

-- Indexes
CREATE INDEX idx_brainstorm_sessions_tenant_id ON brainstorm_sessions(tenant_id);
CREATE INDEX idx_brainstorm_sessions_status ON brainstorm_sessions(status);
CREATE INDEX idx_brainstorm_sessions_tenant_status ON brainstorm_sessions(tenant_id, status);
CREATE INDEX idx_brainstorm_sessions_created_at ON brainstorm_sessions(created_at);
CREATE INDEX idx_brainstorm_sessions_updated_at ON brainstorm_sessions(updated_at);
CREATE INDEX idx_brainstorm_sessions_cancel_requested ON brainstorm_sessions(cancel_requested);
```

```sql
-- Individual AI passes
CREATE TABLE brainstorm_passes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES brainstorm_sessions(id) ON DELETE CASCADE,
    sequence INT NOT NULL CHECK(sequence BETWEEN 1 AND 20),
    role TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
    input_tokens INT,
    output_tokens INT,
    model_cost_usd REAL,
    prompt_path TEXT NOT NULL,
    output_path TEXT NOT NULL,
    error TEXT,
    started_at INT,
    completed_at INT,
    created_at INT NOT NULL,
    updated_at INT NOT NULL,
    UNIQUE(session_id, sequence)
);

-- Indexes
CREATE INDEX idx_brainstorm_passes_session_id ON brainstorm_passes(session_id);
CREATE INDEX idx_brainstorm_passes_status ON brainstorm_passes(status);
CREATE INDEX idx_brainstorm_passes_sequence ON brainstorm_passes(sequence);
```

```sql
-- Idempotency keys for safe retries
CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY CHECK(length(key) = 64), -- SHA-256 hex
    result TEXT NOT NULL, -- JSON string
    expires_at INT NOT NULL -- Unix timestamp (3600s TTL)
);
```

---

### **TypeScript Types**

```ts
interface BrainstormSession {
  id: string;
  name: string;
  description: string;
  specs: string | null;
  status: 'intake' | 'configuring' | 'ready' | 'running' | 'paused' | 'done' | 'failed' | 'canceled' | 'interrupted';
  modelTier: 'free' | 'paid';
  recommendedPasses: number | null;
  targetPasses: number;
  completedPasses: number;
  planV1Path: string | null;
  planV2Path: string | null;
  summaryPath: string | null;
  workflowId: string | null;
  complexityScore: number | null;
  cancelRequested: boolean;
  tenantId: string;
  createdAt: number;
  updatedAt: number;
}

interface BrainstormPass {
  id: string;
  sessionId: string;
  sequence: number;
  role: string;
  model: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  inputTokens: number | null;
  outputTokens: number | null;
  modelCostUsd: number | null;
  promptPath: string;
  outputPath: string;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
```

---

### **Session State Machine**

| Current State → Action | start() | cancel() | complete() | fail() | injectMessage() |
|------------------------|--------|--------|-----------|--------|-----------------|
| **intake** | → configuring | → canceled | — | — | — |
| **configuring** | → ready | → canceled | — | — | — |
| **ready** | → running | → canceled | — | — | ✅ (noop) |
| **running** | — | → cancel_requested | → done (if all pass) | → failed | ✅ |
| **paused** | → running | → canceled | — | — | ✅ |
| **done** | — | — | — | — | ✅ |
| **failed** | → ready (retry) | → canceled | — | — | ✅ |
| **canceled** | — | — | — | — | ✅ |
| **interrupted** | → ready | → canceled | — | — | ✅ |

> `cancel_requested` is a flag; actual state becomes `canceled` after cleanup.

---

## **4. API Contract**

### **Endpoints**

| Method | Path | Auth | Request | Response | Errors |
|--------|------|------|---------|----------|--------|
| `POST` | `/api/brainstorm/sessions` | ✅ | `{name, description, specs?}` | `BrainstormSession` | `400` (invalid), `403` (rate limit), `409` (max sessions) |
| `GET` | `/api/brainstorm/sessions` | ✅ | — | `BrainstormSession[]` | — |
| `GET` | `/api/brainstorm/sessions/:id` | ✅ | — | `BrainstormSession & {passes: BrainstormPass[]}` | `404`, `403` |
| `DELETE` | `/api/brainstorm/sessions/:id` | ✅ | — | `204` | `404`, `403`, `409` (running) |
| `POST` | `/api/brainstorm/sessions/:id/start` | ✅ | — | `202` | `409` (not ready), `423` (locked) |
| `POST` | `/api/brainstorm/sessions/:id/message` | ✅ | `{content: string, idempotencyKey?: string}` | `201` | `400`, `403`, `404`, `409` (duplicate) |
| `POST` | `/api/brainstorm/sessions/:id/create-workflow` | ✅ | — | `{workflowId: string}` | `400`, `404`, `500` |
| `GET` | `/api/brainstorm/sessions/:id/stream` | ✅ (via `?token=`) | — | SSE stream | `401`, `403`, `404` |

> All mutating endpoints use `checkToken()` and tenant isolation.

---

### **SSE Event Catalog**

| Event | Payload | Fired When |
|-------|--------|------------|
| `session_updated` | `{session: BrainstormSession}` | Any session field changes |
| `pass_started` | `{pass: BrainstormPass}` | Pass status → `running` |
| `pass_completed` | `{pass: BrainstormPass, output: string}` | Pass completed, file written |
| `pass_failed` | `{pass: BrainstormPass, error: string}` | LLM or system error |
| `message_received` | `{content: string, timestamp: number}` | User message saved |
| `planning_done` | `{planV1Path: string, planV2Path: string}` | All passes complete |
| `workflow_created` | `{workflowId: string}` | Builder run created |
| `error` | `{code: string, message: string}` | System-level error (e.g. DB fail) |

> Stream uses `text/event-stream` with 30s keep-alive pings.

---

## **5. Frontend Architecture**

### **Component List (File Paths)**

```
src/components/brainstorm/
├── BrainstormTab.tsx
├── IntakeForm.tsx
├── PassConfigPanel.tsx
├── SmartRecommendationOverlay.tsx
├── SessionView.tsx
├── PassTimeline.tsx
├── PassCard.tsx
├── ConfidenceBar.tsx
├── PlanningHealthIndicator.tsx
├── UserMessageInput.tsx
├── MessageBadge.tsx
├── PlanPreview.tsx
├── SummaryView.tsx
├── BuilderRunCreationPanel.tsx
├── ModelLabel.tsx
├── SessionList.tsx
└── types.ts
```

### **State Management**

| Source | Mechanism | Update Frequency |
|-------|-----------|------------------|
| **Session/Pass Data** | SSE + initial `GET /sessions/:id` | Real-time |
| **Form Input** | Local React state | Immediate |
| **Session List** | Poll `GET /sessions` every 30s | Background |
| **Confidence/Health** | Derived from pass statuses and complexity | SSE-driven |

---

### **Key UX Patterns**

- **Recommendation Overlay**: Triggered by hover/focus on suggested pass count. Uses portal, fades in.
- **ConfidenceBar**: Linear scale: `confidence = min(1, completed_passes / target_passes) * 0.8 + (complexity_score || 0) * 0.2`
- **HealthIndicator**: Pulsing dot when any pass is `running`
- **ModelLabel**: `.pill.green` for `ollama/*`, `.pill.amber` for `gpt-*`, `.pill.red` on error
- **PlanPreview**: During planning → skeleton loader; after → `.markdown` with `white-space: pre-wrap`

---

### **BuilderPage Integration**

- Add `<button>Brainstorm</button>` next to existing tabs
- Route: `/builder?tab=brainstorm`
- Dynamically render `<BrainstormTab />` inside tab content area
- No changes to other tabs

---

## **6. Backend Architecture**

### **Orchestrator Design (Module Pattern)**

Stateless functions in `server/orchestrator/brainstorm.ts`:

```ts
startSession(sessionId: string): Promise<void>
runNextPass(sessionId: string): Promise<void>
completeSession(sessionId: string): Promise<void>
recoverOrphanedSessions(): Promise<void>
```

Each pass:
1. Locks session (via DB `FOR UPDATE`)
2. Updates pass status to `running`
3. Calls `callLiteLLM()` with role-specific prompt
4. Writes output to file
5. Updates pass + session atomically in transaction

---

### **Confidence Score Algorithm**

```
confidence = (
  (completed_passes / target_passes) * 0.4 +
  (presence of "security" pass) * 0.2 +
  (presence of "critic" pass) * 0.2 +
  (no LLM errors in last 3 passes) * 0.2
)
```

Rounded to 2 decimals.

---

### **V1/V2/Summary Consolidation**

- **Model**: `mistral:7b` (free) → `gpt-3.5-turbo` (fallback)
- **Max Tokens**: 2048
- **Prompt Structure**:
  ```xml
  <consolidation_role>V1_PLAN</consolidation_role>
  <input_passes>
    <pass role="architect">...</pass>
    ...
  </input_passes>
  <instructions>Produce non-technical summary...</instructions>
  ```

---

### **Orphan Recovery**

On server boot:
```sql
UPDATE brainstorm_sessions
SET status = 'interrupted'
WHERE status = 'running' AND updated_at < unixepoch('now', '-5 minutes');
```

Cron job every 5m: retry `interrupted` sessions.

---

### **SSE Connection Management**

- Each client connects to `/stream?id=...&token=...`
- Server maintains `Map<tenantId, Set<EventSource>>`
- On session update: broadcast to all tenant listeners
- Close stale connections after 60s inactivity

---

### **callLiteLLM Utility**

```ts
async function callLiteLLM(
  prompt: string,
  modelPolicy: string[],
  signal?: AbortSignal
): Promise<LLMResponse>
```

- Retries: 2x with 10s delay
- Timeout: 60s
- Uses free models first, falls back
- Wraps prompt in XML delimiters
- Returns tokens/cost if available

---

## **7. Security Design**

### **Input Validation**
- All fields validated server-side (length, regex, allowed chars)
- Strips control characters, scripts, `on*=` attributes
- DB uses parameterized queries

### **Prompt Injection Prevention**
Wrap all user inputs in XML:
```xml
<user_name>{name}</user_name>
<user_description>{description}</user_description>
<user_specs>{specs}</user_specs>
```

### **SSE Auth**
- Token passed via `?token=...` (temporary, to be replaced by cookies)
- `checkToken()` validates before accepting connection

### **Path Validation**
- Session IDs: `^[a-zA-Z0-9_-]+$`
- File paths use `PASS_FILE()`, `PLAN_V1_PATH()` templates
- All paths resolved via `path.resolve()` + `realpath()` sandbox

### **Rate Limits**
- Max 50 sessions/tenant
- Max 2 concurrent `running` sessions/tenant
- Max 10 messages/session

### **Tenant Isolation**
- All queries filter by `tenant_id`
- File paths include `/{tenantId}/`

### **Builder Workflow Security**
- Generated workflows use allowlisted agents/models
- `agentOrder` validated before DB insert
- Git/risk policies enforced via `validationProfile.internal`

### **Structured Logging**
- All logs: JSON, timestamp, level, event
- Redact tokens, model keys, user PII
- Log: session start, pass start, workflow create

---

## **8. Integration Points**

- **BuilderPage.tsx**: Add tab button and conditional `<BrainstormTab />`
- **Router**: No new routes — client-side tab routing
- **Workflow Creation**: POST to `/api/builder/workflows` with `status: "draft"`
- **DB Migration**: Run `008_brainstorm.sql` on deploy

---

## **9. Implementation Milestones**

| Phase | Tasks | Hours (Free Models) |
|------|------|---------------------|
| **1. Backend Foundation** | DB schema, CRUD, state machine, migration | 16h |
| **2. Orchestrator** | LiteLLM, passes, SSE, recovery | 24h |
| **3. Frontend Basics** | Components, session view, timeline | 20h |
| **4. Smart UX** | Confidence, overlays, labels, health | 12h |
| **5. Integration** | Workflow create, export, E2E test | 16h |

> Total: ~88 hours. Can be parallelized.

---

## **10. Risk Register**

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| LLM fails mid-pass | H | M | Retry + fallback models |
| Session state corruption | M | H | Atomic DB transactions |
| SSE disconnect under load | M | M | Reconnect logic + polling fallback |
| Prompt injection bypass | L | H | XML sandboxing + input sanitization |
| Tenant data leak | L | H | Tenant-ID scoping + path sandboxing |

---

## **11. Open Questions**

1. **projectRoot UX**: Should users select project context? → Defer to V2.
2. **Pass count cap**: Max 8 passes. Prevent infinite loops.
3. **Plan retention**: Files auto-purged after 30 days (nightly cron).
4. **Tenant orchestrator isolation**: Use tenant-scoped queues in future; for now, rate limits suffice.