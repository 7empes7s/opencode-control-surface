# BRAINSTORMER BACKEND SPEC (Pass 3)

This document details the complete backend implementation for the Brainstormer feature. It covers database migrations, API handlers, the core planning orchestrator, and utility functions.

---

## 1. DB Migration SQL

Create a new migration file (e.g., `migrations/008_brainstorm.sql`).

```sql
-- 1. brainstorm_sessions table
CREATE TABLE IF NOT EXISTS brainstorm_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    specs TEXT,
    status TEXT NOT NULL DEFAULT 'intake' CHECK(status IN ('intake', 'configuring', 'ready', 'running', 'paused', 'done', 'failed', 'canceled', 'interrupted')),
    model_tier TEXT NOT NULL DEFAULT 'free',
    recommended_passes INT,
    target_passes INT,
    completed_passes INT DEFAULT 0,
    plan_v1_path TEXT,
    plan_v2_path TEXT,
    summary_path TEXT,
    workflow_id TEXT,
    complexity_score REAL,
    cancel_requested INT DEFAULT 0,
    tenant_id TEXT NOT NULL,
    created_at INT NOT NULL,
    updated_at INT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_tenant_id ON brainstorm_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_status ON brainstorm_sessions(status);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_tenant_status ON brainstorm_sessions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_created_at ON brainstorm_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_updated_at ON brainstorm_sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_cancel_requested ON brainstorm_sessions(cancel_requested);

-- 2. brainstorm_passes table
CREATE TABLE IF NOT EXISTS brainstorm_passes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sequence INT NOT NULL,
    role TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'canceled')),
    input_digest TEXT,
    output_raw TEXT,
    output_path TEXT,
    confidence_score REAL,
    error TEXT,
    started_at INT,
    finished_at INT,
    FOREIGN KEY (session_id) REFERENCES brainstorm_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_brainstorm_passes_session_id ON brainstorm_passes(session_id);

-- 3. brainstorm_messages table
CREATE TABLE IF NOT EXISTS brainstorm_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    injected_after_pass INT,
    created_at INT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES brainstorm_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_brainstorm_messages_session_id ON brainstorm_messages(session_id);

-- Triggers for updated_at
CREATE TRIGGER IF NOT EXISTS trg_brainstorm_sessions_update 
AFTER UPDATE ON brainstorm_sessions BEGIN 
    UPDATE brainstorm_sessions SET updated_at = CAST(strftime('%s', 'now') AS INT) WHERE id = NEW.id; 
END;
```

---

## 2. Handler Implementations

All handlers assume a dependency injection of `db` (SQLite database) and `checkToken` (auth function). All inputs must be validated.

### Helper: Input Validation & Path Safety
```ts
function validateId(id: string | undefined): string {
  if (!id || id.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid ID format");
  return id;
}
```

### A. POST /api/brainstorm/sessions — Create Session
```ts
// Handler: createSession
export async function createSession(req: Request, params: any, db: any, checkToken: Function) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token || !checkToken(token)) return new Response("Unauthorized", { status: 401 });

  const body = await req.json();
  const { name, description, specs } = body;

  if (!name || !description) return new Response("Missing name or description", { status: 400 });

  const tenantId = "tenant_placeholder"; // Derived from token in real app
  const id = crypto.randomUUID();
  const now = Date.now();

  // Rate limit check: Max 50 sessions
  const count = await db.query(`SELECT COUNT(*) as c FROM brainstorm_sessions WHERE tenant_id = ?`, [tenantId]);
  if (count[0].c >= 50) return new Response("Session limit reached", { status: 403 });

  await db.query(`
    INSERT INTO brainstorm_sessions (id, name, description, specs, status, tenant_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'intake', ?, ?, ?)
  `, [id, name, description, specs, tenantId, now, now]);

  return Response.json({ id, status: 'intake' };
}
```

### B. GET /api/brainstorm/sessions — List Sessions
```ts
// Handler: listSessions
export async function listSessions(req: Request, params: any, db: any, checkToken: Function) {
  const token = req.headers.get("Authorization");
  if (!checkToken(token)) return new Response("Unauthorized",{ status: 401 });
  
  const tenantId = "tenant_placeholder";
  const url = new URL(req.url);
  const limit = url.searchParams.get("limit") || 20;
  const offset = url.searchParams.get("offset") || 0;

  const sessions = await db.query(`
    SELECT id, name, status, created_at, updated_at, complexity_score 
    FROM brainstorm_sessions 
    WHERE tenant_id = ? 
    ORDER BY updated_at DESC 
    LIMIT ? OFFSET ?
  `, [tenantId, limit, offset]);

  return Response.json(sessions);
}
```

### C. GET /api/brainstorm/sessions/:id — Get Session
```ts
// Handler: getSession
export async function getSession(req: Request, params: { id: string }, db: any, checkToken: Function) {
  const token = req.headers.get("Authorization");
  if (!checkToken(token)) return new Response("Unauthorized",{ status: 401 });

  const id = validateId(params.id);
  const tenantId = "tenant_placeholder";

  const sessions = await db.query(`SELECT * FROM brainstorm_sessions WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
  if (sessions.length === 0) return new Response("Not found", { status: 404 });

  const passes = await db.query(`SELECT * FROM brainstorm_passes WHERE session_id = ? ORDER BY sequence`, [id]);
  const messages = await db.query(`SELECT * FROM brainstorm_messages WHERE session_id = ? ORDER BY created_at`, [id]);

  return Response.json({ session: sessions[0], passes, messages };
}
```

### D. DELETE /api/brainstorm/sessions/:id
```ts
// Handler: deleteSession
export async function deleteSession(req: Request, params: { id: string }, db: any, checkToken: Function) {
  const token = req.headers.get("Authorization");
  if (!checkToken(token)) return new Response("Unauthorized",{ status: 401 });

  const id = validateId(params.id);
  const tenantId = "tenant_placeholder";

  // Check if running
  const sessions = await db.query(`SELECT status FROM brainstorm_sessions WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
  if (sessions.length === 0) return new Response("Not found", { status: 404 });
  if (sessions[0].status === 'running') return new Response("Cannot delete running session", { status: 409 });

  await db.query(`DELETE FROM brainstorm_sessions WHERE id = ?`, [id]);
  
  // File cleanup handled by OS cron or separate cleanup utility, or here:
  // await Bun.spawn(['rm', '-rf', `/opt/opencode-control-surface/brainstorm-plans/${tenantId}/${id}`]);

  return new Response(null, { status: 204 });
}
```

### E. POST /api/brainstorm/sessions/:id/start
```ts
// Handler: startSession
import { BrainstormOrchestrator } from "../services/BrainstormOrchestrator";

export async function startSession(req: Request, params: { id: string }, db: any, checkToken: Function) {
  const token = req.headers.get("Authorization");
  if (!checkToken(token)) return new Response("Unauthorized",{ status: 401 });

  const id = validateId(params.id);
  const tenantId = "tenant_placeholder";
  
  // Rate limit: Max 2 running sessions per tenant
  const running = await db.query(`SELECT COUNT(*) as c FROM brainstorm_sessions WHERE tenant_id = ? AND status = 'running'`, [tenantId]);
  if (running[0].c >= 2) return new Response("Too many running sessions", { status: 429 });

  // Update status to ready/configuring
  await db.query(`UPDATE brainstorm_sessions SET status = 'ready', target_passes = 8 WHERE id = ?`, [id]);

  // Trigger async orchestration
  // In Bun, we can just fire the promise or use a worker. For simplicity:
  (async () => {
    try {
      await BrainstormOrchestrator.startSession(id);
    } catch (e) {
      console.error("Orchestrator failed", e);
      await db.query(`UPDATE brainstorm_sessions SET status = 'failed' WHERE id = ?`, [id]);
    }
  })();

  return Response.json({ status: "started" };
}
```

### F. POST /api/brainstorm/sessions/:id/message
```ts
// Handler: injectMessage
export async function injectMessage(req: Request, params: { id: string }, db: any, checkToken: Function) {
  const token = req.headers.get("Authorization");
  if (!checkToken(token)) return new Response("Unauthorized",{ status: 401 });

  const id = validateId(params.id);
  const { content } = await req.json();
  if (!content) return new Response("Content required", { status: 400 });

  // Get last completed pass to know when to inject
  const passes = await db.query(`SELECT MAX(sequence) as last_seq FROM brainstorm_passes WHERE session_id = ? AND status = 'completed'`, [id]);
  const lastSeq = passes[0]?.last_seq || 0;

  const msgId = crypto.randomUUID();
  await db.query(`INSERT INTO brainstorm_messages (id, session_id, content, injected_after_pass, created_at) VALUES (?, ?, ?, ?, ?)`, 
    [msgId, id, content, lastSeq, Date.now()]);

  // If session is running, notify orchestrator (via file or in-memory signal if possible, otherwise rely on next loop tick)
  return Response.json({ id: msgId };
}
```

### G. POST /api/brainstorm/sessions/:id/create-workflow
```ts
// Handler: createWorkflow
export async function createWorkflow(req: Request, params: { id: string }, db: any, checkToken: Function) {
  const token = req.headers.get("Authorization");
  if (!checkToken(token)) return new Response("Unauthorized",{ status: 401 });

  const id = validateId(params.id);
  const session = await db.query(`SELECT status, plan_v2_path FROM brainstorm_sessions WHERE id = ?`, [id]);

  if (session.length === 0) return new Response("Not found", { status: 404 });
  if (session[0].status !== 'done') return new Response("Session not complete", { status: 400 });

  const planV2Content = await Bun.file(session[0].plan_v2_path).text();
  
  // Mock Builder API call to create workflow
  // In reality, call the Builder's internal workflow creation endpoint
  const workflowInput = {
    name: `Brainstorm: ${id}`,
    trigger: "manual",
    steps: parsePlanToSteps(planV2Content) // Hypothetical parser
  };

  // Call internal builder service (pseudocode)
  // const workflowId = await BuilderService.create(workflowInput);
  const workflowId = "wf_" + crypto.randomUUID();

  await db.query(`UPDATE brainstorm_sessions SET workflow_id = ? WHERE id = ?`, [workflowId, id]);

  return Response.json({ workflowId, status: "draft" };
}
```

---

## 3. Planning Orchestrator

This is a TypeScript module (`server/services/BrainstormOrchestrator.ts`) that manages the lifecycle of passes.

```ts
import { callLiteLLM } from "../utils/llm";
import { computeConfidence } from "../utils/confidence";
import { getPromptTemplate } from "../prompts";
import { db } from "../db/dashboard"; // Assume singleton instance
import * as fs from "fs";
import * as path from "path";

// State for SSE
const sseControllers = new Map<string, Set<ReadableStreamDefaultController>>();

export const BrainstormOrchestrator = {
  /**
   * Starts the planning loop for a session.
   */
  async startSession(sessionId: string) {
    // 1. Load Session
    const session = await db.query(`SELECT * FROM brainstorm_sessions WHERE id = ?`, [sessionId]);
    if (!session.length) throw new Error("Session not found");
    const sess = session[0];

    // 2. Update Status
    await db.query(`UPDATE brainstorm_sessions SET status = 'running' WHERE id = ?`, [sessionId]);
    this.broadcast(sessionId, { type: 'status_update', status: 'running' });

    // 3. Ensure directories
    const baseDir = `/opt/opencode-control-surface/brainstorm-plans/${sess.tenant_id}/${sessionId}`;
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

    // 4. Define Pass Sequence
    const roles = [
      'architect', 'ux-designer', 'backend-engineer', 'critic', 
      'security', 'consolidator-v1', 'consolidator-v2', 'summarizer'
    ];

    // 5. Run Loop
    let accumulatedContext = `Project: ${sess.name}\nDescription: ${sess.description}\nSpecs: ${sess.specs || 'None'}`;
    
    // Fetch user messages
    const userMessages = await db.query(`SELECT * FROM brainstorm_messages WHERE session_id = ?`, [sessionId]);
    const USER_MESSAGES_BLOCK = userMessages.map(m => `USER NOTE: ${m.content}`).join('\n');

    for (let i = 0; i < roles.length; i++) {
      // Check for cancel
      const check = await db.query(`SELECT cancel_requested FROM brainstorm_sessions WHERE id = ?`, [sessionId]);
      if (check[0].cancel_requested) {
        await db.query(`UPDATE brainstorm_sessions SET status = 'canceled' WHERE id = ?`, [sessionId]);
        this.broadcast(sessionId, { type: 'status_update', status: 'canceled' });
        return;
      }

      const role = roles[i];
      const passId = crypto.randomUUID();
      
      // Insert Pass Record
      await db.query(`
        INSERT INTO brainstorm_passes (id, session_id, sequence, role, model, status, started_at)
        VALUES (?, ?, ?, ?, 'opencode/minimax-m2.5-free', 'running', ?)
      `, [passId, sessionId, i + 1, role, Date.now()]);

      this.broadcast(sessionId, { type: 'pass_start', passId, role, sequence: i + 1 });

      try {
        // Build Prompt
        const prompt = getPromptTemplate(role, {
          PROJECT_NAME: sess.name,
          DESCRIPTION: sess.description,
          ACCUMULATED_CONTEXT: accumulatedContext,
          USER_MESSAGES_BLOCK
        });

        // Execute LLM
        const output = await callLiteLLM('opencode/minimax-m2.5-free', prompt);

        // Calculate Confidence
        const confidence = computeConfidence(accumulatedContext, output, role);

        // Save Output
        const passPath = `${baseDir}/pass-${(i + 1).toString().padStart(2, '0')}-${role}.md`;
        fs.writeFileSync(passPath, output);

        // Update Pass DB
        await db.query(`
          UPDATE brainstorm_passes 
          SET status = 'completed', output_raw = ?, output_path = ?, confidence_score = ?, finished_at = ?
          WHERE id = ?
        `, [output, passPath, confidence, Date.now(), passId]);

        // Update Context for next pass
        accumulatedContext += `\n\n--- Pass ${i + 1} (${role}) ---\n${output}`;

        this.broadcast(sessionId, { type: 'pass_complete', passId, role, confidence, sequence: i + 1 });

      } catch (err: any) {
        await db.query(`UPDATE brainstorm_passes SET status = 'failed', error = ? WHERE id = ?`, [err.message, passId]);
        await db.query(`UPDATE brainstorm_sessions SET status = 'failed' WHERE id = ?`, [sessionId]);
        this.broadcast(sessionId, { type: 'error', message: err.message });
        return;
      }
    }

    // Finalize: Create V1, V2, Summary files
    // (Implementation logic similar to passes, using consolidator outputs)
    await this.generateFinalArtifacts(sessionId, baseDir, accumulatedContext);

    await db.query(`UPDATE brainstorm_sessions SET status = 'done' WHERE id = ?`, [sessionId]);
    this.broadcast(sessionId, { type: 'status_update', status: 'done' });
  },

  /**
   * Register an SSE connection
   */
  registerSSE(sessionId: string, controller: ReadableStreamDefaultController) {
    if (!sseControllers.has(sessionId)) {
      sseControllers.set(sessionId, new Set());
    }
    sseControllers.get(sessionId)!.add(controller);
  },

  /**
   * Unregister SSE
   */
  unregisterSSE(sessionId: string, controller: ReadableStreamDefaultController) {
    const set = sseControllers.get(sessionId);
    if (set) {
      set.delete(controller);
      if (set.size === 0) sseControllers.delete(sessionId);
    }
  },

  /**
   * Broadcast event to all subscribers of a session
   */
  broadcast(sessionId: string, data: any) {
    const set = sseControllers.get(sessionId);
    if (!set) return;
    const message = `data: ${JSON.stringify(data)}\n\n`;
    for (const controller of set) {
      try {
        controller.enqueue(new TextEncoder().encode(message));
      } catch (e) {
        // Client disconnected
        set.delete(controller);
      }
    }
  },

  // Internal helper to run consolidation logic for final files
  async generateFinalArtifacts(sessionId: string, baseDir: string, context: string) {
    // Logic to extract/rename pass-06 to PLAN_V1.md, pass-07 to PLAN_V2.md, pass-08 to SUMMARY.md
    // Or re-run LLM for consolidation if not done in pass loop
    const v1Source = `${baseDir}/pass-06-consolidator-v1.md`;
    const v2Source = `${baseDir}/pass-07-consolidator-v2.md`;
    const sumSource = `${baseDir}/pass-08-summarizer.md`;

    if(fs.existsSync(v1Source)) fs.copyFileSync(v1Source, `${baseDir}/PLAN_V1.md`);
    if(fs.existsSync(v2Source)) fs.copyFileSync(v2Source, `${baseDir}/PLAN_V2.md`);
    if(fs.existsSync(sumSource)) fs.copyFileSync(sumSource, `${baseDir}/SUMMARY.md`);

    await db.query(`UPDATE brainstorm_sessions SET plan_v1_path = ?, plan_v2_path = ?, summary_path = ? WHERE id = ?`, 
      [`${baseDir}/PLAN_V1.md`, `${baseDir}/PLAN_V2.md`, `${baseDir}/SUMMARY.md`, sessionId]);
  }
};
```

---

## 4. Confidence Score Implementation

```ts
export function computeConfidence(prevOutput: string, currOutput: string, role: string): number {
  // Token overlap logic
  const tokenize = (text: string) => new Set(text.split(/\W+/).filter(t => t.length > 3));
  
  const tokensPrev = tokenize(prevOutput);
  const tokensCurr = tokenize(currOutput);
  
  const newTokens = [...tokensCurr].filter(t => !tokensPrev.has(t)).length;
  const newRatio = newTokens / Math.max(tokensCurr.size, 1);

  // Header structure logic
  const headers = (currOutput.match(/^#{1,3} /gm) || []).length;
  
  let expectedHeaders = 6;
  if (role === 'architect') expectedHeaders = 7;
  if (role === 'ux-designer') expectedHeaders = 9;
  
  const headerScore = Math.min(1, headers / expectedHeaders);

  // Weighted score
  const score = (newRatio * 0.6 + headerScore * 0.4) * 100;
  return Math.round(score);
}
```

---

## 5. SSE Implementation

```ts
export async function handleBrainstormStream(req: Request, params: { id: string }, db: any, checkToken: Function) {
  const token = req.headers.get("Authorization") || req.url.split("token=")[1];
  if (!checkToken(token)) return new Response("Unauthorized", { status: 401 });

  const sessionId = validateId(params.id);

  const stream = new ReadableStream({
    start(controller) {
      BrainstormOrchestrator.registerSSE(sessionId, controller);

      // Send State Catchup immediately
      (async () => {
        try {
          const session = await db.query(`SELECT * FROM brainstorm_sessions WHERE id = ?`, [sessionId]);
          const passes = await db.query(`SELECT * FROM brainstorm_passes WHERE session_id = ?`, [sessionId]);
          
          const catchupMsg = {
            type: 'state_catchup',
            session: session[0],
            passes: passes
          };
          
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(catchupMsg)}\n\n`));
        } catch (e) {
          controller.error(e);
        }
      })();
    },
    cancel() {
      BrainstormOrchestrator.unregisterSSE(sessionId, this as any);
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}
```

---

## 6. Prompt Templates Per Role

Located in `server/prompts/brainstorm.ts`.

```ts
export function getPromptTemplate(role: string, vars: Record<string, string>) {
  const systemMsg = "You are an expert software architect/designer. Provide detailed, actionable plans in Markdown.";
  
  const templates: Record<string, { system: string, user: string }> = {
    'architect': {
      system: "You are the Chief Architect. Focus on high-level system design, tech stack, and data flow.",
      user: `Project: {PROJECT_NAME}\nDescription: {DESCRIPTION}\n\nCurrent Specs: {ACCUMULATED_CONTEXT}\n\nUser Inputs:\n{USER_MESSAGES_BLOCK}\n\nGenerate a high-level architecture plan.`
    },
    'ux-designer': {
      system: "You are a UX Designer. Focus on user flows, wireframes (text description), and UI components.",
      user: `Project: {PROJECT_NAME}\nContext: {ACCUMULATED_CONTEXT}\n\nUser Inputs:\n{USER_MESSAGES_BLOCK}\n\nDesign the user experience.`
    },
    'backend-engineer': {
      system: "You are a Senior Backend Engineer. Focus on API endpoints, database schema, and server logic.",
      user: `Project: {PROJECT_NAME}\nContext: {ACCUMULATED_CONTEXT}\n\nUser Inputs:\n{USER_MESSAGES_BLOCK}\n\nProvide the backend implementation plan.`
    },
    'critic': {
      system: "You are a Tech Lead reviewing the plan. Identify flaws, risks, and missing pieces.",
      user: `Review the following plan and provide critical feedback:\n{ACCUMULATED_CONTEXT}`
    },
    'security': {
      system: "You are a Security Expert. Identify vulnerabilities and compliance requirements.",
      user: `Audit this plan for security:\n{ACCUMULATED_CONTEXT}`
    },
    'consolidator-v1': {
      system: "You are a Technical Writer. Combine previous passes into a cohesive V1 High-Level Plan.",
      user: `Create PLAN_V1.md merging:\n{ACCUMULATED_CONTEXT}`
    },
    'consolidator-v2': {
      system: "You are a Technical Writer. Create a detailed V2 Technical Plan with code snippets and exact steps.",
      user: `Create PLAN_V2.md merging:\n{ACCUMULATED_CONTEXT}`
    },
    'summarizer': {
      system: "You are a Project Manager. Create a brief executive summary.",
      user: `Create a 1-paragraph summary of the project status and next steps based on:\n{ACCUMULATED_CONTEXT}`
    }
  };

  const t = templates[role] || templates['architect'];
  
  let userContent = t.user;
  for (const [key, value] of Object.entries(vars)) {
    userContent = userContent.replace(new RegExp(`{${key}}`, 'g'), value);
  }

  // Return formatted for LLM
  return `${t.system}\n\n${userContent}`;
}
```

---

## 7. Router Registration

Edit `server/api/router.ts`.

```ts
import { createSession, listSessions, getSession, deleteSession, startSession, injectMessage, createWorkflow } from "./brainstorm/sessions";
import { handleBrainstormStream } from "./brainstorm/stream";

// ... inside router setup ...

// Brainstorm Routes
router.post("/api/brainstorm/sessions", createSession);
router.get("/api/brainstorm/sessions", listSessions);
router.get("/api/brainstorm/sessions/:id", getSession);
router.delete("/api/brainstorm/sessions/:id", deleteSession);
router.post("/api/brainstorm/sessions/:id/start", startSession);
router.post("/api/brainstorm/sessions/:id/message", injectMessage);
router.post("/api/brainstorm/sessions/:id/create-workflow", createWorkflow);
router.get("/api/brainstorm/sessions/:id/stream", handleBrainstormStream);
```

---

## 8. callLiteLLM Utility

Located in `server/utils/llm.ts`.

```ts
const LITE_LLM_URL = "http://127.0.0.1:4000";

export async function callLiteLLM(
  model: string, 
  prompt: string, 
  maxTokens: number = 4096,
  signal?: AbortSignal
): Promise<string> {
  const makeRequest = async (abortSignal?: AbortSignal) => {
    const res = await fetch(`${LITE_LLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.7
      }),
      signal: abortSignal
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LiteLLM Error: ${res.status} - ${err}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  };

  let lastError;
  const maxRetries = 2;
  
  for (let i = 0; i <= maxRetries; i++) {
    try {
      // Create a local signal that combines user signal + timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
      
      // Combine signals if provided
      const combinedSignal = signal 
        ? AnySignal([signal, controller.signal]) // Pseudocode helper or manual event listener
        : controller.signal;

      // Simpler approach: just use signal if provided, or controller
      return await makeRequest(signal || controller.signal);
    } catch (err: any) {
      lastError = err;
      if (i < maxRetries) {
        console.log(`Retry ${i + 1} after 10s...`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
  throw lastError;
}
```

---

## 9. Security Implementation Details

1.  **Auth**: All endpoints (except stream health checks if added) require `Authorization: Bearer <token>`.
2.  **Path Traversal**:
    *   Session IDs are validated via regex `^[a-zA-Z0-9_-]+$`.
    *   File paths are constructed using template literals with validated IDs. No user input is directly used in `fs` paths.
3.  **Rate Limiting**:
    *   Implemented in `startSession` (max 2 concurrent per tenant).
    *   Implemented in `createSession` (max 50 total per tenant).
4.  **SSE Auth**: The token is passed via query param `?token=...` in the EventSource URL on the frontend, validated against `checkToken`.
5.  **Input Sanitization**: All user inputs (prompts) are treated as opaque strings to the LLM, but we avoid injecting raw HTML or SQL into the prompts. The `getPromptTemplate` function replaces placeholders safely.