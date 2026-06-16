import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { getDashboardDb } from '../db/dashboard.ts';
import { checkToken } from './actions.ts';
import { getCurrentTenantContext } from '../tenancy/middleware.ts';
import { createBrainstormSession } from '../builder/brainstorm-orchestrator.ts';

const app = new Hono();

app.post('/session', async (c) => {
  if (!checkToken(c.req.raw)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = getCurrentTenantContext();
  const body = await c.req.json();
  const { name, description, specs, project_mode, codebase_path } = body;

  if (!name || !description || typeof name !== 'string' || typeof description !== 'string') {
    return c.json({ error: 'Missing required fields: name, description' }, 400);
  }

  if (name.length > 100 || description.length > 2000 || (specs && specs.length > 1000)) {
    return c.json({ error: 'Field length exceeded' }, 400);
  }

  const db = getDashboardDb()!;
  const existingCount = db
    .prepare('SELECT COUNT(*) as count FROM brainstorm_sessions WHERE tenant_id = ?')
    .get(tenantId) as { count: number };

  if (existingCount.count >= 50) {
    return c.json({ error: 'Max 50 sessions per tenant' }, 429);
  }

  const session = await createBrainstormSession({
    id: crypto.randomUUID().replace(/-/g, ''),
    name,
    description,
    specs: specs || null,
    tenantId,
    project_mode: project_mode || 'new',
    codebase_path: codebase_path || null,
  });

  return c.json(session, 201);
});

app.patch('/session/:id/config', async (c) => {
  if (!checkToken(c.req.raw)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = getCurrentTenantContext();
  const sessionId = c.req.param('id');
  const body = await c.req.json();
  const { target_passes } = body;

  if (!target_passes || target_passes < 3 || target_passes > 8) {
    return c.json({ error: 'target_passes must be 3–8' }, 400);
  }

  const db = getDashboardDb()!;
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
  `).run(target_passes, Date.now(), sessionId);

  return c.json({ success: true });
});

app.post('/session/:id/start', async (c) => {
  if (!checkToken(c.req.raw)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = getCurrentTenantContext();
  const sessionId = c.req.param('id');

  const db = getDashboardDb()!;
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
    .run(Date.now(), sessionId);

  import('../builder/brainstorm-orchestrator.ts').then(mod => mod.runBrainstormLoop(sessionId));

  return c.json({ success: true });
});

app.post('/session/:id/message', async (c) => {
  if (!checkToken(c.req.raw)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = getCurrentTenantContext();
  const sessionId = c.req.param('id');
  const body = await c.req.json();
  const { content } = body;

  if (!content || typeof content !== 'string') {
    return c.json({ error: 'Missing content' }, 400);
  }

  const db = getDashboardDb()!;
  const session = db
    .prepare('SELECT * FROM brainstorm_sessions WHERE id = ? AND tenant_id = ?')
    .get(sessionId, tenantId) as any;

  if (!session) return c.json({ error: 'Session not found' }, 404);

  import('../builder/brainstorm-orchestrator.ts').then(mod => mod.injectUserMessage(sessionId, content));

  return c.json({ success: true });
});

app.get('/session/:id', async (c) => {
  if (!checkToken(c.req.raw)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = getCurrentTenantContext();
  const sessionId = c.req.param('id');

  const db = getDashboardDb()!;
  const session = db
    .prepare('SELECT * FROM brainstorm_sessions WHERE id = ? AND tenant_id = ?')
    .get(sessionId, tenantId) as any;

  if (!session) return c.json({ error: 'Session not found' }, 404);

  return c.json(session);
});

// Full detail for a session: every planning pass (role, output, model, tokens,
// cost) plus the generated plan documents read from disk. Powers the Plan view.
app.get('/session/:id/detail', async (c) => {
  if (!checkToken(c.req.raw)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = getCurrentTenantContext();
  const sessionId = c.req.param('id');

  const db = getDashboardDb()!;
  const session = db
    .prepare('SELECT * FROM brainstorm_sessions WHERE id = ? AND tenant_id = ?')
    .get(sessionId, tenantId) as any;

  if (!session) return c.json({ error: 'Session not found' }, 404);

  const passes = db
    .prepare(`SELECT pass_number, role, response, model_used, input_tokens, output_tokens, cost, created_at
              FROM brainstorm_pass_logs WHERE session_id = ? ORDER BY pass_number ASC`)
    .all(sessionId);

  // Only read files under the trusted plan root (defense against path traversal
  // from a tampered DB value).
  const PLAN_ROOT = '/var/lib/control-surface/brainstorm-plans';
  const readPlan = (p?: string): string | null => {
    if (!p || !p.startsWith(PLAN_ROOT) || !existsSync(p)) return null;
    try { return readFileSync(p, 'utf8'); } catch { return null; }
  };

  let researchSources: Array<{ title: string; url: string }> = [];
  try {
    if (session.research_sources) researchSources = JSON.parse(session.research_sources);
  } catch { researchSources = []; }

  return c.json({
    passes,
    plans: {
      v2: readPlan(session.plan_v2_path),
      v1: readPlan(session.plan_v1_path),
      summary: readPlan(session.summary_path),
    },
    research: session.research_context
      ? { context: session.research_context, sources: researchSources }
      : null,
  });
});

app.get('/sessions', async (c) => {
  if (!checkToken(c.req.raw)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = getCurrentTenantContext();
  const db = getDashboardDb()!;

  const sessions = db
    .prepare('SELECT * FROM brainstorm_sessions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(tenantId);

  return c.json(sessions);
});

app.post('/session/:id/workflow', async (c) => {
  if (!checkToken(c.req.raw)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { tenantId } = getCurrentTenantContext();
  const sessionId = c.req.param('id');

  const db = getDashboardDb()!;
  const session = db
    .prepare('SELECT * FROM brainstorm_sessions WHERE id = ? AND tenant_id = ?')
    .get(sessionId, tenantId) as any;

  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.status !== 'done') return c.json({ error: 'Session not completed' }, 400);

  const workflowId = await import('../builder/brainstorm-orchestrator.ts').then(mod => mod.createWorkflowFromSession(sessionId));

  return c.json({ workflowId });
});

export default app;