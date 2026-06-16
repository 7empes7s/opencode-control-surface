# **BRAINSTORMER FEATURE — IMPLEMENTATION GUIDE V2**

---

## **1. Complete File Manifest**

| Absolute Path | Action | Description |
|---------------|--------|-------------|
| `server/db/migrations/add_brainstorm_tables.sql` | create | DB schema for Brainstormer sessions and pass logs |
| `server/api/brainstorm-actions.ts` | create | REST endpoints: POST `/session`, PATCH `/session/:id/config`, POST `/session/:id/start`, POST `/session/:id/message`, POST `/session/:id/workflow` |
| `server/builder/brainstorm-orchestrator.ts` | create | Core logic: `runLoop`, `executePass`, `runConsolidation`, `broadcastEvent` |
| `app/components/brainstorm/IntakeForm.tsx` | create | Form to start new session with name, description, specs |
| `app/components/brainstorm/PassConfigPanel.tsx` | create | Panel to set `target_passes`, see model tier, confidence bar |
| `app/components/brainstorm/SmartRecommendationOverlay.tsx` | create | Overlay suggesting pass count based on description length |
| `app/components/brainstorm/PassTimeline.tsx` | create | Vertical timeline of all 8 passes with status pills |
| `app/components/brainstorm/UserMessageInput.tsx` | create | Input box for injecting user feedback mid-planning |
| `app/routes/BrainstormPage.tsx` | create | Full tab component for Brainstormer UI |
| `app/routes/BuilderPage.tsx` | modify | Add "Brainstorm" tab button and conditional rendering |
| `server/api/router.ts` | modify | Register new `/api/brainstorm/*` routes |
| `.gitignore` | modify | Add `/opt/opencode-control-surface/brainstorm-plans` to ignored paths |
| `server/utils/cron/brainstorm-purge.ts` | create | Nightly job to delete sessions older than 30 days |

---

## **2. Database Migration**

File: `server/db/migrations/add_brainstorm_tables.sql`

```sql
-- Create brainstorm_sessions table if not exists
CREATE TABLE IF NOT EXISTS brainstorm_sessions (
    id TEXT PRIMARY KEY CHECK (id REGEXP '^[a-zA-Z0-9_-]+$'),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
    specs TEXT CHECK (length(specs) <= 1000),
    status TEXT NOT NULL DEFAULT 'intake' 
        CHECK(status IN ('intake', 'configuring', 'ready', 'running', 'paused', 'done', 'failed', 'interrupted', 'canceled')),
    model_tier TEXT NOT NULL DEFAULT 'free' CHECK(model_tier IN ('free', 'pro')),
    recommended_passes INT CHECK (recommended_passes BETWEEN 3 AND 8),
    target_passes INT NOT NULL DEFAULT 6 CHECK (target_passes BETWEEN 3 AND 8),
    completed_passes INT NOT NULL DEFAULT 0 CHECK (completed_passes >= 0),
    plan_v1_path TEXT,
    plan_v2_path TEXT,
    summary_path TEXT,
    workflow_id TEXT,
    complexity_score REAL CHECK (complexity_score >= 0.0 AND complexity_score <= 1.0),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    tenant_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_tenant_id ON brainstorm_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_status ON brainstorm_sessions(status);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_workflow_id ON brainstorm_sessions(workflow_id);

-- Create brainstorm_pass_logs table if not exists
CREATE TABLE IF NOT EXISTS brainstorm_pass_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    pass_number INT NOT NULL CHECK (pass_number >= 1),
    role TEXT NOT NULL,
    prompt TEXT NOT NULL,
    response TEXT NOT NULL,
    model_used TEXT NOT NULL,
    input_tokens INT,
    output_tokens INT,
    cost REAL,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    FOREIGN KEY (session_id) REFERENCES brainstorm_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_brainstorm_pass_logs_session_id ON brainstorm_pass_logs(session_id);
```

**Execution Instructions:**

- Run during server startup using `migrateDb()` function in `server/db/index.ts`
- Check existence of table via `PRAGMA table_info(brainstorm_sessions);`
- Execute only if schema changes are detected or force-migrate flag is set

---

## **3. server/api/brainstorm-actions.ts**

```ts
import { Hono } from 'hono';
import { getDashboardDb } from '../../utils/db';
import { checkToken } from '../../utils/auth';
import { getCurrentTenantContext } from '../../utils/tenant';
import { createSession } from '../builder/brainstorm-orchestrator';

const app = new Hono();

// POST /api/brainstorm/session
app.post('/session', async (c) => {
  const authToken = c.req.header('Authorization')?.split(' ')[1];
  if (!authToken || !(await checkToken(authToken))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = await getCurrentTenantContext(authToken);
  const body = await c.req.json();
  const { name, description, specs } = body;

  if (!name || !description || typeof name !== 'string' || typeof description !== 'string') {
    return c.json({ error: 'Missing required fields: name, description' }, 400);
  }

  if (name.length > 100 || description.length > 2000 || (specs && specs.length > 1000)) {
    return c.json({ error: 'Field length exceeded' }, 400);
  }

  const db = getDashboardDb();
  const existingCount = db
    .prepare('SELECT COUNT(*) as count FROM brainstorm_sessions WHERE tenant_id = ?')
    .get(tenantId) as { count: number };

  if (existingCount.count >= 50) {
    return c.json({ error: 'Max 50 sessions per tenant' }, 429);
  }

  const session = await createSession({
    id: crypto.randomUUID().replace(/-/g, ''),
    name,
    description,
    specs: specs || null,
    tenantId,
  });

  return c.json(session, 201);
});

// PATCH /api/brainstorm/session/:id/config
app.patch('/session/:id/config', async (c) => {
  const authToken = c.req.header('Authorization')?.split(' ')[1];
  if (!authToken || !(await checkToken(authToken))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = await getCurrentTenantContext(authToken);
  const sessionId = c.req.param('id');
  const body = await c.req.json();
  const { target_passes } = body;

  if (!target_passes || target_passes < 3 || target_passes > 8) {
    return c.json({ error: 'target_passes must be 3–8' }, 400);
  }

  const db = getDashboardDb();
  const session = db
    .prepare('SELECT * FROM brainstorm_sessions WHERE id = ? AND tenant_id = ?')
    .get(sessionId, tenantId) as any;

  if (!session) return c.json({ error: 'Session not found' }, 404);

  if (session.status !== 'intake' && session.status !== 'configuring') {
    return c.json({ error: 'Cannot configure running session' }, 400);
  }

  db.prepare(`
    UPDATE brainstorm_sessions 
    SET target_passes = ?, status = 'ready', updated_at = ?
    WHERE id = ?
  `).run(target_passes, Math.floor(Date.now() / 1000), sessionId);

  return c.json({ success: true });
});

// POST /api/brainstorm/session/:id/start
app.post('/session/:id/start', async (c) => {
  const authToken = c.req.header('Authorization')?.split(' ')[1];
  if (!authToken || !(await checkToken(authToken))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = await getCurrentTenantContext(authToken);
  const sessionId = c.req.param('id');

  const db = getDashboardDb();
  const session = db
    .prepare('SELECT * FROM brainstorm_sessions WHERE id = ? AND tenant_id = ?')
    .get(sessionId, tenantId) as any;

  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.status !== 'ready') return c.json({ error: 'Session not ready' }, 400);

  const runningCount = db
    .prepare('SELECT COUNT(*) as count FROM brainstorm_sessions WHERE tenant_id = ? AND status = "running"')
    .get(tenantId) as { count: number };

  if (runningCount.count >= 2) {
    return c.json({ error: 'Max 2 concurrent running sessions' }, 429);
  }

  db.prepare('UPDATE brainstorm_sessions SET status = "running", updated_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), sessionId);

  // Fire-and-forget async execution
  import('../../builder/brainstorm-orchestrator').then(mod => mod.runLoop(sessionId));

  return c.json({ success: true });
});

export default app;
```

---

## **4. server/builder/brainstorm-orchestrator.ts**

```ts
import { getDashboardDb } from '../../utils/db';
import { callLiteLLM } from '../../utils/llm';
import { broadcastEvent } from './sse-broadcaster';
import { PASS_FILE, PLAN_V1_PATH, PLAN_V2_PATH, SUMMARY_PATH } from '../../utils/paths';
import * as fs from 'fs/promises';
import * as path from 'path';

const PASSES = [
  { role: 'Architect', max_tokens: 512 },
  { role: 'UX Designer', max_tokens: 512 },
  { role: 'Backend Engineer', max_tokens: 512 },
  { role: 'Critic', max_tokens: 512 },
  { role: 'Security Analyst', max_tokens: 512 },
  { role: 'V1 Planner', max_tokens: 1024 },
  { role: 'V2 Planner', max_tokens: 1024 },
  { role: 'Summary Generator', max_tokens: 512 }
] as const;

export async function runLoop(sessionId: string): Promise<void> {
  const db = getDashboardDb();
  let session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;
  if (!session || session.status !== 'running') return;

  const context: string[] = [];
  const tenantId = session.tenantId;

  for (let i = 0; i < PASSES.length; i++) {
    if (session.cancel_requested) break;

    const pass = PASSES[i];
    const seq = i + 1;

    try {
      const output = await executePass(sessionId, seq, pass.role, context, tenantId);
      context.push(output.trim());
      session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;
    } catch (err) {
      db.prepare('UPDATE brainstorm_sessions SET status = "failed", updated_at = ? WHERE id = ?')
        .run(Math.floor(Date.now() / 1000), sessionId);
      broadcastEvent(tenantId, sessionId, 'error', { message: (err as Error).message });
      return;
    }
  }

  await runConsolidation(sessionId, context, tenantId);
  db.prepare('UPDATE brainstorm_sessions SET status = "done", updated_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), sessionId);
  broadcastEvent(tenantId, sessionId, 'done', {});
}

export async function executePass(
  sessionId: string,
  seq: number,
  role: string,
  context: string[],
  tenantId: string
): Promise<string> {
  const db = getDashboardDb();
  const session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;

  const prompt = buildPrompt(role, session, context);
  const response = await callLiteLLM(prompt, ['ollama/phi3', 'gpt-3.5-turbo'], undefined, PASSES[seq - 1].max_tokens);

  const output = response.choices[0]?.message?.content || '';
  const filePath = PASS_FILE(tenantId, sessionId, seq, role);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, output, 'utf-8');

  db.prepare(`
    INSERT INTO brainstorm_pass_logs (session_id, pass_number, role, prompt, response, model_used, input_tokens, output_tokens, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, seq, role, prompt, output, response.model, response.usage?.prompt_tokens, response.usage?.completion_tokens, response.cost);

  db.prepare('UPDATE brainstorm_sessions SET completed_passes = ?, updated_at = ? WHERE id = ?')
    .run(seq, Math.floor(Date.now() / 1000), sessionId);

  broadcastEvent(tenantId, sessionId, 'pass_update', { seq, role, status: 'completed' });

  return `<pass role="${role}" seq="${seq}">\n${output}\n</pass>`;
}

function buildPrompt(role: string, session: any, context: string[]): string {
  const seed = `
You are a senior ${role}. Your task is to provide expert feedback on this software idea.
Respond only in markdown. Do not repeat instructions. Be concise and actionable.
User’s idea:
<user_name>${session.name}</user_name>
<user_description>${session.description}</user_description>
<user_specs>${session.specs || 'None'}</user_specs>
Previous analysis:
${context.join('\n')}
Current role: ${role}
Output:
  `.trim();

  return seed;
}

export async function runConsolidation(sessionId: string, context: string[], tenantId: string): Promise<void> {
  const db = getDashboardDb();
  const session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;

  // PLAN_V1: High-level feature plan
  const v1Prompt = `
Summarize the idea into a non-technical plan for stakeholders.
Include: Goal, Key Features, User Flow, Success Criteria.
Use markdown.

Idea:
<user_name>${session.name}</user_name>
<user_description>${session.description}</user_description>
<user_specs>${session.specs || ''}</user_specs>
Analysis:
${context.join('\n')}

Output:
  `.trim();

  const v1Resp = await callLiteLLM(v1Prompt, ['ollama/phi3'], undefined, 1024);
  const v1Content = v1Resp.choices[0]?.message?.content || '';
  const v1Path = PLAN_V1_PATH(tenantId, sessionId);
  await fs.writeFile(v1Path, v1Content, 'utf-8');
  db.prepare('UPDATE brainstorm_sessions SET plan_v1_path = ? WHERE id = ?').run(v1Path, sessionId);

  // PLAN_V2: Technical spec
  const v2Prompt = `
Generate a technical specification for engineers.
Include: agentOrder sequence, validation rules, git policies, risk flags.
Use code blocks for JSON/YAML.

Idea + V1:
${v1Content}
Analysis:
${context.join('\n')}

Output:
  `.trim();

  const v2Resp = await callLiteLLM(v2Prompt, ['gpt-3.5-turbo'], undefined, 1024);
  const v2Content = v2Resp.choices[0]?.message?.content || '';
  const v2Path = PLAN_V2_PATH(tenantId, sessionId);
  await fs.writeFile(v2Path, v2Content, 'utf-8');
  db.prepare('UPDATE brainstorm_sessions SET plan_v2_path = ? WHERE id = ?').run(v2Path, sessionId);

  // SUMMARY.md
  const summaryPrompt = `
Compute a confidence score (0.0–1.0) for successful implementation.
List 3 success criteria and 1 risk.
Format:
## Confidence Score
0.xx
## Success Criteria
- ...
## Risk
- ...
  `.trim();

  const sumResp = await callLiteLLM(summaryPrompt, ['gpt-3.5-turbo'], undefined, 512);
  const sumContent = sumResp.choices[0]?.message?.content || '';
  const sumPath = SUMMARY_PATH(tenantId, sessionId);
  await fs.writeFile(sumPath, sumContent, 'utf-8');
  db.prepare('UPDATE brainstorm_sessions SET summary_path = ? WHERE id = ?').run(sumPath, sessionId);

  broadcastEvent(tenantId, sessionId, 'consolidation_done', {});
}
```

---

## **5. app/routes/BuilderPage.tsx Changes**

```diff
import { useState } from 'react';
+ import BrainstormPage from './BrainstormPage';

export default function BuilderPage() {
  const [activeTab, setActiveTab] = useState<'build' | 'brainstorm'>('build');

  return (
    <div className="h-screen flex flex-col">
      <div className="flex border-b">
        <button
          className={`px-4 py-2 ${activeTab === 'build' ? 'border-b-2 border-blue-600' : ''}`}
          onClick={() => setActiveTab('build')}
        >
          Build
        </button>
+       <button
+         className={`px-4 py-2 ${activeTab === 'brainstorm' ? 'border-b-2 border-blue-600' : ''}`}
+         onClick={() => setActiveTab('brainstorm')}
+       >
+         Brainstorm
+       </button>
      </div>
      <div className="flex-1 overflow-hidden">
+       {activeTab === 'brainstorm' && <BrainstormPage />}
        {activeTab === 'build' && <LegacyBuilderView />}
      </div>
    </div>
  );
}
```

---

## **6. app/routes/BrainstormPage.tsx**

```tsx
import { useState, useEffect } from 'react';
import IntakeForm from '../components/brainstorm/IntakeForm';
import PassConfigPanel from '../components/brainstorm/PassConfigPanel';
import PassTimeline from '../components/brainstorm/PassTimeline';
import UserMessageInput from '../components/brainstorm/UserMessageInput';

interface Session {
  id: string;
  name: string;
  status: string;
  completed_passes: number;
  target_passes: number;
}

export default function BrainstormPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/brainstorm/sessions', {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
    })
      .then(r => r.json())
      .then(setSessions);
  }, []);

  useEffect(() => {
    if (!currentSession) return;
    const es = new EventSource(`/api/brainstorm/stream?id=${currentSession.id}&token=${localStorage.getItem('token')}`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      setEvents(prev => [...prev, data]);
      if (data.type === 'pass_update') {
        setCurrentSession(prev => prev ? { ...prev, completed_passes: data.seq } : null);
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [currentSession?.id]);

  if (!currentSession) {
    return <IntakeForm onCreate={(s) => { setSessions([s, ...sessions]); setCurrentSession(s); }} />;
  }

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">{currentSession.name}</h1>
      {currentSession.status === 'intake' && <PassConfigPanel session={currentSession} />}
      {currentSession.status === 'running' && (
        <>
          <PassTimeline session={currentSession} events={events} />
          <UserMessageInput sessionId={currentSession.id} />
        </>
      )}
    </div>
  );
}
```

---

## **7. Key Sub-Components**

### **IntakeForm.tsx**
```tsx
import { useState } from 'react';

export default function IntakeForm({ onCreate }: { onCreate: (session: any) => void }) {
  const [form, setForm] = useState({ name: '', description: '', specs: '' });

  const submit = async () => {
    const res = await fetch('/api/brainstorm/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
      body: JSON.stringify(form)
    });
    const session = await res.json();
    onCreate(session);
  };

  return (
    <div className="space-y-4">
      <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Feature Name" className="w-full p-2 border" />
      <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Describe your idea..." className="w-full p-2 border h-32" />
      <textarea value={form.specs} onChange={e => setForm({ ...form, specs: e.target.value })} placeholder="Optional specs (e.g. mobile, Supabase)" className="w-full p-2 border h-24" />
      <button onClick={submit} className="bg-blue-600 text-white px-4 py-2">Start Planning</button>
    </div>
  );
}
```

### **PassConfigPanel.tsx**
```tsx
import { useState } from 'react';
import SmartRecommendationOverlay from './SmartRecommendationOverlay';

export default function PassConfigPanel({ session }: { session: any }) {
  const [passes, setPasses] = useState(6);

  const save = () => fetch(`/api/brainstorm/session/${session.id}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: JSON.stringify({ target_passes: passes })
  });

  return (
    <div className="bg-gray-100 p-4 rounded">
      <SmartRecommendationOverlay descriptionLength={session.description.length} />
      <label>Passes: <input type="range" min="3" max="8" value={passes} onChange={e => setPasses(+e.target.value)} /> {passes}</label>
      <button onClick={save} className="bg-green-600 text-white px-4 py-2 mt-2">Start Planning</button>
    </div>
  );
}
```

### **PassTimeline.tsx**
```tsx
export default function PassTimeline({ session, events }: { session: any; events: any[] }) {
  const passes = ['Architect', 'UX Designer', 'Backend', 'Critic', 'Security', 'V1', 'V2', 'Summary'];
  const completed = session.completed_passes;

  return (
    <div className="space-y-2">
      {passes.map((role, i) => {
        const seq = i + 1;
        const status = seq <= completed ? 'completed' : seq === completed + 1 ? 'active' : 'pending';
        return (
          <div key={role} className="flex items-center gap-2">
            <div className={`w-6 h-6 rounded-full ${status === 'completed' ? 'bg-green-500' : status === 'active' ? 'bg-yellow-500' : 'bg-gray-300'}`}></div>
            <span>{role}</span>
          </div>
        );
      })}
    </div>
  );
}
```

### **UserMessageInput.tsx**
```tsx
import { useState } from 'react';

export default function UserMessageInput({ sessionId }: { sessionId: string }) {
  const [msg, setMsg] = useState('');

  const send = () => fetch(`/api/brainstorm/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: JSON.stringify({ content: msg })
  });

  return (
    <div className="mt-4">
      <textarea value={msg} onChange={e => setMsg(e.target.value)} placeholder="Add feedback..." className="w-full p-2 border" />
      <button onClick={send} className="bg-blue-600 text-white px-4 py-2 mt-2">Inject</button>
    </div>
  );
}
```

---

## **8. LiteLLM Prompt Templates**

**Architect:**
```
You are a senior Architect. Design the high-level system.
Respond in markdown.

User’s idea:
<user_name>${name}</user_name>
<user_description>${description}</user_description>
<user_specs>${specs}</user_specs>

Output:
```

**UX Designer:**
```
You are a senior UX Designer. Sketch the user journey.
Include: screens, flows, mobile concerns.

Previous:
${context}

Output:
```

---

## **9. SSE Event Format**

Example event:
```
data: {"type":"pass_update","seq":3,"role":"Backend Engineer","status":"completed"}
\n\n
```

Valid types: `pass_update`, `error`, `done`, `consolidation_done`, `message_injected`

---

## **10. Builder Workflow Creation**

```ts
app.post('/session/:id/workflow', async (c) => {
  const sessionId = c.req.param('id');
  const db = getDashboardDb();
  const session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;

  const workflowInput = {
    name: session.name,
    description: session.description,
    agentOrder: ["planner", "coder", "reviewer"],
    projectRoot: "/projects/default",
    validationProfile: "internal",
    git: { autoCommit: true, branch: "brainstorm/main" },
    riskFlags: ["experimental"],
    source: "brainstormer",
    sourceSessionId: sessionId
  };

  const newWorkflow = await createBuilderWorkflow(workflowInput);
  db.prepare('UPDATE brainstorm_sessions SET workflow_id = ? WHERE id = ?').run(newWorkflow.id, sessionId);

  return c.json({ workflowId: newWorkflow.id });
});
```

---

## **11. Router Registration**

In `server/api/router.ts`:
```ts
import brainstormRoutes from './brainstorm-actions';
app.route('/api/brainstorm', brainstormRoutes);
```

---

## **12. Validation & Deployment Checklist**

1. `bun server/db/migrate.ts` → run migration
2. `mkdir -p /opt/opencode-control-surface/brainstorm-plans`
3. Add `/opt/opencode-control-surface/brainstorm-plans` to `.gitignore`
4. `bun run typecheck`
5. `bun run build`
6. `systemctl restart control-surface.service`
7. Smoke test: create session → start → verify first pass → inject message → check SSE events

---

## **13. Builder Agent Instructions**

- **Never modify existing routes** — only add new files and endpoints.
- Use `checkToken()` from `utils/auth` for all auth checks.
- Use `getDashboardDb()` and `getCurrentTenantContext()` patterns.
- `LITELLM_MASTER_KEY` is in `process.env.LITELLM_MASTER_KEY`.
- Run `bun run typecheck` after every file edit.
- **Do not install new npm packages** — use only existing dependencies.
- All file paths must use `PASS_FILE()` and `PLAN_V1_PATH()` helpers.
- Validate session ownership by `tenant_id` on every request.
- **Never auto-launch workflows** — always set status `"draft"`.

✅ **You are now ready to implement.**

<!-- Builder run br_1da9d: failed at 2026-05-20T13:35:19.841Z — details: /opt/ai-vault/builder/2026-05-20-bw_0ff09-br_1da9d.md -->