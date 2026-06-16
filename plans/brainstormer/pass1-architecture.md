# **BRAINSTORMER ARCHITECTURE (Pass 1)**

---

## **1. SQLite Schema**

```sql
-- Table: brainstorm_sessions
CREATE TABLE brainstorm_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    specs TEXT,
    status TEXT NOT NULL CHECK(status IN ('intake', 'configuring', 'ready', 'running', 'paused', 'done', 'failed', 'canceled', 'interrupted')),
    model_tier TEXT NOT NULL DEFAULT 'free',
    recommended_passes INT,
    target_passes INT,
    completed_passes INT DEFAULT 0,
    plan_v1_path TEXT,
    plan_v2_path TEXT,
    summary_path TEXT,
    workflow_id TEXT,
    complexity_score REAL,
    cancel_requested INT DEFAULT 0, -- BOOLEAN as INTEGER (0 = false, 1 = true)
    tenant_id TEXT NOT NULL,
    created_at INT NOT NULL,
    updated_at INT NOT NULL
);

-- Indexes for brainstorm_sessions
CREATE INDEX idx_brainstorm_sessions_tenant_id ON brainstorm_sessions(tenant_id);
CREATE INDEX idx_brainstorm_sessions_status ON brainstorm_sessions(status);
CREATE INDEX idx_brainstorm_sessions_tenant_status ON brainstorm_sessions(tenant_id, status);
CREATE INDEX idx_brainstorm_sessions_created_at ON brainstorm_sessions(created_at);
CREATE INDEX idx_brainstorm_sessions_updated_at ON brainstorm_sessions(updated_at);
CREATE INDEX idx_brainstorm_sessions_cancel_requested ON brainstorm_sessions(cancel_requested);


-- Table: brainstorm_passes
CREATE TABLE brainstorm_passes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sequence INT NOT NULL,
    role TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'canceled')),
    input_digest TEXT,
    output_raw TEXT,
    output_path TEXT,
    confidence_score REAL,
    error TEXT,
    started_at INT,
    finished_at INT,
    FOREIGN KEY (session_id) REFERENCES brainstorm_sessions(id) ON DELETE CASCADE
);

-- Indexes for brainstorm_passes
CREATE INDEX idx_brainstorm_passes_session_id ON brainstorm_passes(session_id);
CREATE INDEX idx_brainstorm_passes_sequence ON brainstorm_passes(session_id, sequence);
CREATE INDEX idx_brainstorm_passes_role ON brainstorm_passes(role);
CREATE INDEX idx_brainstorm_passes_status ON brainstorm_passes(status);
CREATE INDEX idx_brainstorm_passes_session_status ON brainstorm_passes(session_id, status);
CREATE INDEX idx_brainstorm_passes_started_at ON brainstorm_passes(started_at);


-- Table: brainstorm_messages
CREATE TABLE brainstorm_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    injected_after_pass INT NOT NULL DEFAULT -1,
    created_at INT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES brainstorm_sessions(id) ON DELETE CASCADE
);

-- Indexes for brainstorm_messages
CREATE INDEX idx_brainstorm_messages_session_id ON brainstorm_messages(session_id);
CREATE INDEX idx_brainstorm_messages_injected_after_pass ON brainstorm_messages(session_id, injected_after_pass);
CREATE INDEX idx_brainstorm_messages_created_at ON brainstorm_messages(created_at);
```

---

## **2. TypeScript Types**

```ts
// Union types for enums
type BrainstormSessionStatus =
  | 'intake'
  | 'configuring'
  | 'ready'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted';

type BrainstormPassStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

type BrainstormPassRole =
  | 'architect'
  | 'ux-designer'
  | 'backend-engineer'
  | 'critic'
  | 'security'
  | 'consolidator-v1'
  | 'consolidator-v2'
  | 'summarizer';

type ComplexityLevel = 'simple' | 'medium' | 'complex';

// DB-backed types
interface BrainstormSession {
  id: string;
  name: string;
  description: string;
  specs: string | null;
  status: BrainstormSessionStatus;
  model_tier: 'free' | 'premium'; // Only 'free' allowed initially
  recommended_passes: number | null;
  target_passes: number | null;
  completed_passes: number;
  plan_v1_path: string | null;
  plan_v2_path: string | null;
  summary_path: string | null;
  workflow_id: string | null;
  complexity_score: number | null;
  cancel_requested: 0 | 1;
  tenant_id: string;
  created_at: number;
  updated_at: number;
}

interface BrainstormPass {
  id: string;
  session_id: string;
  sequence: number;
  role: BrainstormPassRole;
  model: string;
  status: BrainstormPassStatus;
  input_digest: string | null;
  output_raw: string | null;
  output_path: string | null;
  confidence_score: number | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

interface BrainstormMessage {
  id: string;
  session_id: string;
  content: string;
  injected_after_pass: number; // -1 = not injected yet
  created_at: number;
}

// View model for API responses
interface BrainstormSessionView extends BrainstormSession {
  passes: BrainstormPass[];
  messages: BrainstormMessage[];
}

// Input for session creation
interface BrainstormSessionInput {
  name: string;
  description: string;
  specs?: string | null;
  target_passes?: number | null;
  model_tier?: 'free' | 'premium';
}

// Optional: Helper for complexity-based pass count
interface PassRecommendation {
  recommended: number;
  complexity: ComplexityLevel;
  multiplier: number;
  reason: string;
}
```

---

## **3. Session State Machine**

| From Status       | To Status         | Trigger                                | DB Fields Updated                                      |
|-------------------|-------------------|----------------------------------------|--------------------------------------------------------|
| intake            | configuring       | POST /sessions (after validation)      | status='configuring', created_at=now, updated_at=now   |
| configuring       | ready             | User confirms settings (UI)            | status='ready', recommended_passes, target_passes      |
| ready             | running           | POST /start                            | status='running', updated_at=now                       |
| running           | paused            | User clicks "Pause"                    | status='paused', updated_at=now                        |
| paused            | running           | User clicks "Resume"                   | status='running', updated_at=now                       |
| running           | done              | All passes complete successfully       | status='done', plan_v1_path, plan_v2_path, summary_path, updated_at |
| running           | failed            | Any pass fails after retries           | status='failed', error in pass, updated_at             |
| running           | canceled          | cancel_requested=1 + no active pass    | status='canceled', updated_at                          |
| paused            | canceled          | User clicks "Cancel"                   | status='canceled', updated_at                          |
| running           | interrupted       | Server crash or orphaned session       | status='interrupted', updated_at (on recovery)         |
| intake            | canceled          | User deletes before start              | status='canceled', updated_at                          |
| configuring       | canceled          | User deletes before start              | status='canceled', updated_at                          |
| ready             | canceled          | User deletes before start              | status='canceled', updated_at                          |

> **Note**: `cancel_requested=1` is a flag set by `/cancel` endpoint; actual status change to `canceled` occurs only when no pass is actively running.

---

## **4. API Endpoints (Full Specification)**

| Method | Path | Auth | Request Body Type | Success Response Type | All Error Codes |
|-------|------|------|-------------------|------------------------|-----------------|
| `POST` | `/api/brainstorm/sessions` | ✅ (checkToken) | `BrainstormSessionInput` | `BrainstormSessionView` | `400` (invalid input), `401` (unauthorized), `500` (DB error) |
| `GET`  | `/api/brainstorm/sessions` | ✅ | — | `BrainstormSession[]` | `401`, `500` |
| `GET`  | `/api/brainstorm/sessions/:id` | ✅ | — | `BrainstormSessionView` | `404` (not found), `401`, `500` |
| `DELETE` | `/api/brainstorm/sessions/:id` | ✅ | — | `204 No Content` | `404`, `401`, `409` (running session), `500` |
| `POST` | `/api/brainstorm/sessions/:id/start` | ✅ | — | `{ sessionId: string, status: 'running' }` | `404`, `401`, `400` (invalid status), `500` |
| `POST` | `/api/brainstorm/sessions/:id/cancel` | ✅ | — | `{ sessionId: string, status: 'canceled' \| 'cancel_requested' }` | `404`, `401`, `500` |
| `POST` | `/api/brainstorm/sessions/:id/message` | ✅ | `{ content: string }` | `BrainstormMessage` | `400`, `404`, `401`, `500` |
| `POST` | `/api/brainstorm/sessions/:id/retry-pass` | ✅ | `{ passId: string }` | `BrainstormPass` | `400`, `404`, `401`, `409` (session not paused), `500` |
| `POST` | `/api/brainstorm/sessions/:id/create-workflow` | ✅ | — | `{ workflowId: string, status: 'draft' }` | `404`, `401`, `400` (session not done), `500` |
| `GET`  | `/api/brainstorm/sessions/:id/stream` | ✅ (`?token=` query) | — | `text/event-stream` | `401` (invalid token), `404`, `500` |
| `GET`  | `/api/brainstorm/sessions/:id/export/:artifact` | ✅ | — | `text/markdown` or `application/octet-stream` | `400` (invalid artifact), `404`, `401`, `500` |

> **Allowed artifacts**: `PLAN_V1.md`, `PLAN_V2.md`, `SUMMARY.md`, `all.zip`

---

## **5. Planning Orchestrator Pseudocode**

### **a) startSession(sessionId)**
```pseudocode
async function startSession(sessionId):
    session = db.get("brainstorm_sessions", sessionId)
    if session.status != "ready":
        throw Error("Session not ready to start")

    db.update(session, { status: "running", updated_at: now() })

    // Offload planning loop to background task
    runPlanningLoop(session) // Non-blocking
    return { sessionId, status: "running" }
```

### **b) runPlanningLoop(session)**
```pseudocode
async function runPlanningLoop(session):
    try:
        for passNum from 1 to session.target_passes:
            // Check cancellation before next pass
            if db.get(session).cancel_requested == 1:
                db.update(session, { status: "canceled", updated_at: now() })
                return

            role = getRoleForPass(passNum)
            model = selectModelForRole(role, session.model_tier)

            pass = createPassRecord(session.id, passNum, role, model)
            await executePass(session, pass)

            // After critic/security passes, check early stop
            if passNum >= 4 and passNum % 3 == 0:
                if checkEarlyStop(session):
                    log("Suggesting early stop due to low convergence")
                    // Continue unless overridden by user

        // Final consolidation phase
        await runConsolidation(session)

        db.update(session, {
            status: "done",
            completed_passes: session.target_passes,
            updated_at: now()
        })

        emitSSE(session.id, "completed", session)
    catch error:
        db.update(session, { status: "failed", updated_at: now() })
        emitSSE(session.id, "error", error)
```

### **c) executePass(session, passNum, role, model)**
```pseudocode
async function executePass(session, passNum, role, model):
    pass = db.get("brainstorm_passes", { session_id: session.id, sequence: passNum })
    db.update(pass, { status: "running", started_at: now() })

    prompt = buildPassPrompt(session, passNum, role)

    try:
        response = await callLiteLLM(model, prompt, timeout=300_000, retries=2)
        rawOutput = response.choices[0].message.content

        // Save raw output
        db.update(pass, { output_raw: rawOutput })

        // Save to file
        filePath = `/opt/opencode-control-surface/brainstorm-plans/${session.tenant_id}/${session.id}/pass-${pad(passNum,2)}-${role}.md`
        fs.writeFile(filePath, rawOutput)

        db.update(pass, { output_path: filePath })

        // Compute confidence
        prevPass = db.getLatestCompletedPass(session.id, passNum - 1)
        if prevPass:
            score = computeConfidenceScore(prevPass.output_raw, rawOutput)
            db.update(pass, { confidence_score: score })

        db.update(pass, { status: "completed", finished_at: now() })
        emitSSE(session.id, "pass-completed", pass)

    catch error:
        db.update(pass, { status: "failed", error: error.message, finished_at: now() })
        throw error
```

### **d) buildPassPrompt(session, passNum, role)**
```pseudocode
function buildPassPrompt(session, passNum, role):
    seed = "Project: ${session.name}\nGoal: ${session.description}\nSpecs: ${session.specs || 'None'}"

    context = [seed]

    // Append all completed pass summaries (titles and first 200 chars)
    for p in db.getPasses(session.id).filter(p => p.sequence < passNum && p.status == "completed"):
        summary = `## Pass ${p.sequence} (${p.role})\n${truncate(p.output_raw, 200)}`
        context.push(summary)

    // Inject user messages between passes
    for m in db.getMessages(session.id).filter(m => m.injected_after_pass == passNum - 1):
        context.push(`USER GUIDANCE [injected between pass ${passNum-1} and ${passNum}]: ${m.content}`)

    rolePrompt = getRolePromptTemplate(role)

    fullPrompt = `
${rolePrompt}

---
CONTEXT:
${join(context, "\n\n")}
---
INSTRUCTIONS:
Write a comprehensive markdown document for this role and pass.
Use clear sections, avoid markdown tables if possible, and write for technical clarity.
Output only the plan — no disclaimers or meta-commentary.
`

    return fullPrompt
```

### **e) computeConfidenceScore(prevOutput, currentOutput)**
```pseudocode
function computeConfidenceScore(prevOutput, currentOutput):
    prevWords = set(tokenize(prevOutput))
    currWords = set(tokenize(currentOutput))

    newWords = currWords - prevWords
    totalWords = size(currWords)

    if totalWords == 0: return 0

    uniquenessRatio = size(newWords) / totalWords

    // Convergence factor: drops as passes increase
    convergenceFactor = max(0.5, 1.0 - (passNum * 0.05))

    score = uniquenessRatio * convergenceFactor * 100
    return clamp(score, 0, 100)
```

### **f) checkEarlyStop(session)**
```pseudocode
function checkEarlyStop(session):
    completed = db.getCompletedPasses(session.id).sort(by sequence, desc)
    last3 = completed.take(3)

    if size(last3) < 3: return false

    allLow = true
    for p in last3:
        if p.confidence_score >= 15: allLow = false

    return allLow
```

### **g) runConsolidation(session)**
```pseudocode
async function runConsolidation(session):
    allOutputs = db.getCompletedPasses(session.id).map(p => p.output_raw).join("\n\n---\n\n")

    // V1: High-level plan
    v1Prompt = `
You are a Senior Tech Architect. Synthesize the following multi-role planning outputs into a single cohesive high-level plan.

Requirements:
- 800-1500 lines
- Sections: Purpose, Architecture Overview, Key Milestones, Risks, Open Questions
- Tone: Executive summary for technical leads
- Avoid redundancies, resolve contradictions

INPUT:
${allOutputs}
`
    v1Model = "opencode/minimax-m2.5-free"
    v1Response = await callLiteLLM(v1Model, v1Prompt, max_tokens=12000, timeout=600_000)
    v1Content = v1Response.choices[0].message.content

    v1Path = `/opt/opencode-control-surface/brainstorm-plans/${session.tenant_id}/${session.id}/PLAN_V1.md`
    fs.writeFile(v1Path, v1Content)
    db.update(session, { plan_v1_path: v1Path })

    // V2: Detailed technical plan
    v2Prompt = `
Now create a detailed implementation guide based on the high-level plan.

Requirements:
- 1200-2000 lines
- Sections: Component Specs, API Contracts (OpenAPI-like), DB Schema (SQL DDL), Deployment Steps
- Include code snippets where helpful
- Assume full-stack JS/TS with Bun and React

INPUT:
${v1Content}
`
    v2Model = "opencode/nemotron-3-super-free"
    v2Response = await callLiteLLM(v2Model, v2Prompt, max_tokens=12000, timeout=600_000)
    v2Content = v2Response.choices[0].message.content

    v2Path = `/opt/opencode-control-surface/brainstorm-plans/${session.tenant_id}/${session.id}/PLAN_V2.md`
    fs.writeFile(v2Path, v2Content)
    db.update(session, { plan_v2_path: v2Path })

    // Summary: Plain English
    sumPrompt = `
Write a non-technical summary of this project plan for a business owner.

Requirements:
- 200-400 words
- One paragraph
- No jargon — explain acronyms
- Highlight value and expected outcome

INPUT:
${v1Content}
`
    sumModel = "opencode/deepseek-v4-flash-free"
    sumResponse = await callLiteLLM(sumModel, sumPrompt, max_tokens=500)
    sumContent = sumResponse.choices[0].message.content

    sumPath = `/opt/opencode-control-surface/brainstorm-plans/${session.tenant_id}/${session.id}/SUMMARY.md`
    fs.writeFile(sumPath, sumContent)
    db.update(session, { summary_path: sumPath })
```

### **h) recoverOrphans()**
```pseudocode
function recoverOrphans():
    // On server startup
    runningSessions = db.query("SELECT * FROM brainstorm_sessions WHERE status = 'running'")
    for s in runningSessions:
        db.update(s, { status: 'interrupted', updated_at: now() })
        log("Recovered orphaned session", s.id)
```

---

## **6. LiteLLM Integration**

### **Configuration**
- **Endpoint**: `http://127.0.0.1:4000/v1/chat/completions`
- **Auth**: `Authorization: Bearer ${process.env.LITELLM_MASTER_KEY}`
- **Headers**:
  ```ts
  {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${LITELLM_MASTER_KEY}`
  }
  ```

### **Model Mapping by Role**
| Role                | Recommended Model (Free Tier)           | Human Label                |
|---------------------|------------------------------------------|----------------------------|
| architect           | opencode/minimax-m2.5-free               | Fast Thinker (free)        |
| ux-designer         | openrouter/google/gemma-4-31b-it:free     | UX Visionary (free)        |
| backend-engineer    | opencode/nemotron-3-super-free           | Deep Analyst (free)        |
| critic              | opencode/qwen3.6-plus-free               | Critical Reviewer (free)   |
| security            | opencode/deepseek-v4-flash-free          | Security Auditor (free)    |
| consolidator-v1/v2  | opencode/nemotron-3-super-free           | Master Integrator (free)   |
| summarizer          | opencode/minimax-m2.5-free               | Plain Talker (free)        |

> Fallback chain: `["opencode/deepseek-v4-flash-free", "opencode/qwen3.6-plus-free"]`

### **Request Options**
```ts
const controller = new AbortController();
const timeoutMs = isConsolidation ? 600_000 : 300_000;
setTimeout(() => controller.abort(), timeoutMs);

const response = await fetch('http://127.0.0.1:4000/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${LITELLM_MASTER_KEY}`
  },
  body: JSON.stringify({
    model: selectedModel,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: isConsolidation ? 12000 : 4096,
    temperature: 0.7
  }),
  signal: controller.signal
});
```

### **Retry Logic**
```ts
async function callLiteLLM(model, prompt, { timeout, maxRetries = 2 }) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await makeRequest(model, prompt, timeout);
    } catch (err) {
      lastError = err;
      if (i < maxRetries) await sleep(10_000); // 10s delay
    }
  }
  throw lastError;
}
```

---

## **7. File System Layout**

```
/opt/opencode-control-surface/brainstorm-plans/
  └── {tenantId}/
      └── {sessionId}/
          ├── pass-01-architect.md
          ├── pass-02-ux-designer.md
          ├── pass-03-backend-engineer.md
          ├── pass-04-critic.md
          ├── pass-05-security.md
          ├── pass-06-consolidator-v1.md
          ├── pass-07-consolidator-v2.md
          ├── pass-08-summarizer.md
          ├── PLAN_V1.md
          ├── PLAN_V2.md
          └── SUMMARY.md
```

### **Path Templates**
```ts
const PASS_FILE = (tenantId: string, sessionId: string, seq: number, role: string) =>
  `/opt/opencode-control-surface/brainstorm-plans/${tenantId}/${sessionId}/pass-${seq.toString().padStart(2, '0')}-${role}.md`;

const PLAN_V1_PATH = (tenantId: string, sessionId: string) =>
  `/opt/opencode-control-surface/brainstorm-plans/${tenantId}/${sessionId}/PLAN_V1.md`;

const PLAN_V2_PATH = (tenantId: string, sessionId: string) =>
  `/opt/opencode-control-surface/brainstorm-plans/${tenantId}/${sessionId}/PLAN_V2.md`;

const SUMMARY_PATH = (tenantId: string, sessionId: string) =>
  `/opt/opencode-control-surface/brainstorm-plans/${tenantId}/${sessionId}/SUMMARY.md`;
```

> **Permissions**: Directories created with `0755`, files with `0644`. Parent dir must be writable by Bun process.

> **Cleanup**: Sessions older than 30 days with status `done`/`canceled`/`failed` are purged nightly.

--- 

**END OF BRAINSTORMER ARCHITECTURE (Pass 1)**  
✅ Ready for Next Pass: UI Component Design & SSE Streaming Implementation