import { getDashboardDb } from '../db/dashboard.ts';
import { broadcastBrainstormEvent } from '../api/brainstorm-stream.ts';
import { mkdirSync } from 'node:fs';
import { DEFAULT_WORKFLOW_CONFIG } from './store.ts';

export const BRAINSTORM_PLAN_ROOT = "/var/lib/control-surface/brainstorm-plans";

mkdirSync(BRAINSTORM_PLAN_ROOT, { recursive: true });

export function brainstormPlanPath(tenantId: string, sessionId: string): string {
  return `${BRAINSTORM_PLAN_ROOT}/${tenantId}/${sessionId}`;
}

export function PASS_FILE(tenantId: string, sessionId: string, seq: number, role: string): string {
  return `${brainstormPlanPath(tenantId, sessionId)}/pass-${seq}-${role.toLowerCase().replace(/\s+/g, '-')}.md`;
}

export function PLAN_V1_PATH(tenantId: string, sessionId: string): string {
  return `${brainstormPlanPath(tenantId, sessionId)}/PLAN_V1.md`;
}

export function PLAN_V2_PATH(tenantId: string, sessionId: string): string {
  return `${brainstormPlanPath(tenantId, sessionId)}/PLAN_V2.md`;
}

export function SUMMARY_PATH(tenantId: string, sessionId: string): string {
  return `${brainstormPlanPath(tenantId, sessionId)}/SUMMARY.md`;
}

interface SessionInput {
  id: string;
  name: string;
  description: string;
  specs: string | null;
  tenantId: string;
  project_mode?: string;
  codebase_path?: string | null;
}

const PASSES = [
  { role: 'Architect', max_tokens: 4000 },
  { role: 'UX Designer', max_tokens: 4000 },
  { role: 'Backend Engineer', max_tokens: 4000 },
  { role: 'Critic', max_tokens: 4000 },
  { role: 'Security Analyst', max_tokens: 4000 },
  { role: 'V1 Planner', max_tokens: 8000 },
  { role: 'V2 Planner', max_tokens: 8000 },
  { role: 'Summary Generator', max_tokens: 2000 }
] as const;

export async function createBrainstormSession(input: SessionInput): Promise<any> {
  const db = getDashboardDb()!;
  const complexity = Math.min(1, (input.description.length / 500 + (input.specs?.length ?? 0) / 200) / 4);
  const recommended = Math.max(3, Math.min(8, Math.round(3 + complexity * 5)));

  db.prepare(`
    INSERT INTO brainstorm_sessions (id, name, description, specs, tenant_id, complexity_score, recommended_passes, target_passes, status, project_mode, codebase_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intake', ?, ?)
  `).run(
    input.id,
    input.name,
    input.description,
    input.specs,
    input.tenantId,
    complexity,
    recommended,
    recommended,
    input.project_mode || 'new',
    input.codebase_path || null
  );

  return db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(input.id);
}

async function readCodebaseFiles(dirPath: string): Promise<string> {
  const parts: string[] = [];

  for (const cf of ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    try {
      const content = await Bun.file(`${dirPath}/${cf}`).text();
      parts.push(`## ${cf}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``);
      break;
    } catch {}
  }

  for (const rf of ['README.md', 'README.txt', 'README']) {
    try {
      const content = await Bun.file(`${dirPath}/${rf}`).text();
      parts.push(`## README\n${content.slice(0, 1500)}`);
      break;
    } catch {}
  }

  try {
    const proc = Bun.spawn(
      ['find', dirPath, '-maxdepth', '3', '!', '-path', '*/.git/*', '!', '-path', '*/node_modules/*', '-type', 'f'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const fileList = await new Response(proc.stdout).text();
    const relevant = fileList.split('\n')
      .filter(f => f.match(/\.(ts|tsx|js|jsx|py|go|rs|java|rb|md)$/) && !f.includes('node_modules'))
      .slice(0, 60);
    if (relevant.length) parts.push(`## File Structure\n${relevant.join('\n')}`);
  } catch {}

  return parts.join('\n\n');
}

export async function runBrainstormLoop(sessionId: string): Promise<void> {
  const db = getDashboardDb()!;
  let session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;
  if (!session || session.status !== 'running') return;

  const tenantId = session.tenant_id || session.tenantId;

  // Codebase analyst pre-pass for existing projects
  if (session.project_mode === 'existing' && session.codebase_path) {
    try {
      const rawContext = await readCodebaseFiles(session.codebase_path);
      const analysisPrompt = `Analyze this codebase and extract:
1. Tech stack and framework versions
2. Architecture pattern (monolith, microservices, MVC, etc.)
3. Naming conventions (file names, variables, functions)
4. Key existing features (brief list)
5. What to preserve — core patterns future additions must respect

Codebase files:
${rawContext}

Output structured markdown, be concise and specific.`;

      const analysisResp = await callLiteLLM(analysisPrompt, 'editorial-cloud-heavy', 2000);
      const codebaseContext = analysisResp.choices[0]?.message?.content || '';

      db.prepare('UPDATE brainstorm_sessions SET codebase_context = ? WHERE id = ?')
        .run(codebaseContext, sessionId);

      // Reload session so subsequent passes have codebase_context
      session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;

      broadcastBrainstormEvent(tenantId, sessionId, 'pass_update', { seq: 0, role: 'Codebase Analyst', status: 'completed' });
    } catch (err) {
      console.error('Codebase analyst pre-pass failed:', err);
      // Non-fatal — continue without codebase context
    }
  }

  const context: string[] = [];
  const sessionDir = brainstormPlanPath(tenantId, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  // Web research pre-pass — gather the current external landscape (competitors,
  // recent developments, common stacks, risks) before the expert passes run, so
  // every downstream role plans against real-world context, not just intuition.
  // Non-fatal: on a rate-limited / offline day this degrades to model-knowledge
  // (clearly labeled) and the brainstorm still proceeds.
  try {
    broadcastBrainstormEvent(tenantId, sessionId, 'pass_update', { seq: 0, role: 'Web Research', status: 'running' });
    const research = await gatherWebResearch(session);
    if (research.brief) {
      const methodLabel = research.method === 'live-web'
        ? 'live web search (Groq Compound)'
        : 'model knowledge — live web unavailable, verify recency';
      const stored = `_Method: ${methodLabel}_\n\n${research.brief}`;
      db.prepare('UPDATE brainstorm_sessions SET research_context = ?, research_sources = ? WHERE id = ?')
        .run(stored, JSON.stringify(research.sources), sessionId);
      const sourcesMd = research.sources.length
        ? '\n\n## Sources\n' + research.sources.map(s => `- [${s.title}](${s.url})`).join('\n')
        : '';
      await Bun.write(`${sessionDir}/RESEARCH.md`, stored + sourcesMd);
      session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;
    }
    broadcastBrainstormEvent(tenantId, sessionId, 'pass_update', { seq: 0, role: 'Web Research', status: 'completed' });
  } catch (err) {
    console.error('Web research pre-pass failed (non-fatal):', err);
    broadcastBrainstormEvent(tenantId, sessionId, 'pass_update', { seq: 0, role: 'Web Research', status: 'skipped' });
  }

  const targetPasses = Math.min(session.target_passes, PASSES.length);

  for (let i = 0; i < targetPasses; i++) {
    const cancelRow = db.prepare('SELECT cancel_requested FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;
    if (cancelRow?.cancel_requested) break;

    const pass = PASSES[i];
    const seq = i + 1;

    try {
      const output = await executePass(sessionId, seq, pass.role, pass.max_tokens, context, tenantId);
      context.push(output.trim());

      session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;
    } catch (err) {
      db.prepare('UPDATE brainstorm_sessions SET status = "failed", updated_at = ? WHERE id = ?')
        .run(Date.now(), sessionId);
      broadcastBrainstormEvent(tenantId, sessionId, 'error', { message: (err as Error).message });
      return;
    }
  }

  await runConsolidation(sessionId, context, tenantId);
  db.prepare('UPDATE brainstorm_sessions SET status = "done", updated_at = ? WHERE id = ?')
    .run(Date.now(), sessionId);
  broadcastBrainstormEvent(tenantId, sessionId, 'done', {});
}

export async function injectUserMessage(sessionId: string, content: string): Promise<void> {
  const db = getDashboardDb()!;
  const session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;
  if (!session) return;

  const tenantId = session.tenantId;
  broadcastBrainstormEvent(tenantId, sessionId, 'message_injected', { content });
}

async function executePass(
  sessionId: string,
  seq: number,
  role: string,
  maxTokens: number,
  context: string[],
  tenantId: string
): Promise<string> {
  const db = getDashboardDb()!;
  const session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;

  const prompt = buildPrompt(role, session, context);
  const response = await callLiteLLM(prompt, 'editorial-cloud-heavy', maxTokens);

  const output = response.choices[0]?.message?.content || '';
  const filePath = PASS_FILE(tenantId, sessionId, seq, role);

  await Bun.write(filePath, output);

  db.prepare(`
    INSERT INTO brainstorm_pass_logs (session_id, pass_number, role, prompt, response, model_used, input_tokens, output_tokens, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, seq, role, prompt, output,
    response.model || 'editorial-cloud-heavy',
    response.usage?.prompt_tokens ?? null,
    response.usage?.completion_tokens ?? null,
    response.cost ?? null
  );

  db.prepare('UPDATE brainstorm_sessions SET completed_passes = ?, updated_at = ? WHERE id = ?')
    .run(seq, Date.now(), sessionId);

  broadcastBrainstormEvent(tenantId, sessionId, 'pass_update', { seq, role, status: 'completed' });

  return `<pass role="${role}" seq="${seq}">\n${output}\n</pass>`;
}

interface ResearchResult {
  brief: string;
  sources: Array<{ title: string; url: string }>;
  method: 'live-web' | 'model-knowledge';
}

function extractUrls(text: string): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string }> = [];
  const re = /https?:\/\/[^\s)\]}"'<>]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < 12) {
    const url = m[0].replace(/[.,);]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url });
  }
  return out;
}

// Gather current external context for the idea. Tier 1 = live web search via the
// `web-research` LiteLLM group (Groq Compound, native server-side search). Tier 2 =
// honest fallback synthesised from model knowledge, explicitly labeled and with NO
// fabricated source URLs, used when live search is rate-limited or errors.
async function gatherWebResearch(session: any): Promise<ResearchResult> {
  const topic = `${session.name}. ${session.description}${session.specs ? ' Specs: ' + session.specs : ''}`.slice(0, 1200);

  const liveQuery = `Research the current (2026) landscape for this software product idea and report findings WITH source URLs:
${topic}

Cover: existing competitors / comparable products, recent (last 6-12 months) developments or news, common technical approaches and stacks, regulatory or market considerations, and notable risks or gaps. Cite source URLs inline. Be specific and current.`;

  try {
    const resp = await callLiteLLM(liveQuery, 'web-research', 2500);
    const content = resp.choices?.[0]?.message?.content?.trim();
    if (content) {
      const sources = extractUrls(content);
      const tools = resp.choices?.[0]?.message?.executed_tools;
      if (Array.isArray(tools)) {
        for (const t of tools) {
          const out = typeof t?.output === 'string' ? t.output : JSON.stringify(t?.output ?? '');
          for (const s of extractUrls(out)) {
            if (sources.length < 12 && !sources.find(x => x.url === s.url)) sources.push(s);
          }
        }
      }
      return { brief: content, sources, method: 'live-web' };
    }
  } catch (err) {
    console.error('web-research (live) unavailable, using model-knowledge fallback:', (err as Error).message);
  }

  const fallbackPrompt = `You do NOT have live web access right now. Based only on your training knowledge, summarize what you know about the current landscape for this software product idea:
${topic}

Cover competitors / comparable products, common technical approaches, market and regulatory considerations, and risks. Explicitly flag where your knowledge may be outdated and what must be verified with live research before committing. Do NOT invent URLs or citations.`;
  const resp = await callLiteLLM(fallbackPrompt, 'editorial-cloud-heavy', 2500);
  const content = resp.choices?.[0]?.message?.content?.trim() || '';
  return { brief: content, sources: [], method: 'model-knowledge' };
}

function buildPrompt(role: string, session: any, context: string[]): string {
  const existingBlock = (session.project_mode === 'existing' && session.codebase_context)
    ? `\n<existing_codebase>\n${session.codebase_context}\n</existing_codebase>\n<instruction>This is an ADDITION to the existing codebase described above. Preserve all existing conventions, tech stack choices, and patterns. Only suggest changes to style or architecture if the user explicitly requested them.</instruction>`
    : '';

  const researchBlock = session.research_context
    ? `\n<web_research>\n${String(session.research_context).slice(0, 6000)}\n</web_research>\n<instruction>Ground your analysis in the current-landscape research above. Reference specific competitors, developments, or constraints from it where relevant rather than reasoning in a vacuum.</instruction>`
    : '';

  return `
You are a senior ${role}. Your task is to provide expert feedback on this software idea.
Respond only in markdown. Do not repeat instructions. Be concise and actionable.

User's idea:
<user_name>${session.name}</user_name>
<user_description>${session.description}</user_description>
<user_specs>${session.specs || 'None'}</user_specs>
${existingBlock}${researchBlock}
Previous analysis:
${context.join('\n')}

Current role: ${role}
Output:
  `.trim();
}

async function callLiteLLM(prompt: string, model: string, maxTokens: number): Promise<any> {
  const litellmUrl = process.env.LITELLM_URL || "http://127.0.0.1:4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;

  const res = await fetch(`${litellmUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(masterKey ? { "Authorization": `Bearer ${masterKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LiteLLM error ${res.status}: ${err}`);
  }

  return res.json();
}

async function runConsolidation(sessionId: string, context: string[], tenantId: string): Promise<void> {
  const db = getDashboardDb()!;
  const session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;

  const researchBlock = session.research_context
    ? `\n<web_research>\n${String(session.research_context).slice(0, 6000)}\n</web_research>\n`
    : '';

  const v1Prompt = `
Write a comprehensive, non-technical product plan for stakeholders. Use markdown with clear headings.

Required sections:
## Goal
## Key Features
## Target Platforms
   List the surfaces the product will ship to (web, iOS, Android, etc.). If the idea calls for mobile apps, note that a single cross-platform codebase will deliver them.
## User Flow
## Phased Roadmap
   Lay out a realistic delivery timeline spanning the full build horizon (typically 6-12 months — use however many phases the scope genuinely needs). For EACH phase give: a name, an approximate duration/timeframe, the phase goal, the concrete deliverables shipped in that phase, and the dependencies it relies on. Order phases so each builds on the last (MVP first, then expansion, then scale/polish).
## Success Criteria
## Key Risks

Ground the roadmap in the current-landscape research where provided; reference real competitors/constraints rather than generic placeholders.
${researchBlock}
Idea:
<user_name>${session.name}</user_name>
<user_description>${session.description}</user_description>
<user_specs>${session.specs || ''}</user_specs>
Analysis:
${context.join('\n')}

Output:
  `.trim();

  const v1Resp = await callLiteLLM(v1Prompt, 'editorial-cloud-heavy', 8000);
  const v1Content = v1Resp.choices[0]?.message?.content || '';
  const v1Path = PLAN_V1_PATH(tenantId, sessionId);
  await Bun.write(v1Path, v1Content);
  db.prepare('UPDATE brainstorm_sessions SET plan_v1_path = ? WHERE id = ?').run(v1Path, sessionId);

  const v2Prompt = `
Generate a detailed technical specification and engineering roadmap for the team that will build this. Use markdown; use code blocks for JSON/YAML.

Required sections:
## Architecture Overview
   Tech stack, major components, and data model — informed by the analysis and the current-landscape research below.
## Target Platforms & Delivery Surfaces
   State every surface the product must ship to (web app, iOS, Android, API, admin, etc.). If mobile is in scope, specify a concrete cross-platform strategy (e.g. a monorepo with a web app + React Native/Expo for iOS & Android sharing a typed API and domain layer) so a single codebase can produce all requested apps. Name the exact frameworks and the shared vs platform-specific boundaries.
## Phased Engineering Roadmap
   A milestone-by-milestone plan spanning the realistic build horizon (typically 6-12 months — as many phases as the scope needs). Present as a table or per-phase blocks. For EACH phase include: name & approximate timeframe, engineering deliverables, the concrete technical tasks/workstreams, dependencies/prerequisites, exit/validation criteria (how we know the phase is done), and the main technical risks.
## Build Checklist
   A granular, ordered checklist of implementation tasks for an autonomous coding agent, written as GitHub-style markdown checkboxes ("- [ ] task"). This is MANDATORY and is what the builder executes — every task MUST start with "- [ ]". Cover the complete first shippable MVP across ALL target platforms above: project/monorepo scaffolding, shared domain & API, data model & migrations, each backend endpoint, each web screen/route, each mobile screen (if in scope), auth, state/data fetching, tests, and the build/typecheck commands to run. Make each item small enough for one agent pass (one file or one cohesive unit). Group items under "### Phase N — <name>" headings. Aim for 30–80 concrete checkbox items so the build can run start-to-finish without a human re-planning mid-way.
## Build Configuration
   The machine-readable config for the autonomous builder, as a JSON code block: agentOrder sequence, validation rules (commands to run, e.g. typecheck/test/build per workspace), git policy, and risk flags.

Be specific and current — reference real libraries, services, and constraints surfaced by the research rather than generic placeholders.
${researchBlock}
Idea + V1 plan:
${v1Content}
Analysis:
${context.join('\n')}

Output:
  `.trim();

  const v2Resp = await callLiteLLM(v2Prompt, 'editorial-cloud-heavy', 8000);
  const v2Content = v2Resp.choices[0]?.message?.content || '';
  const v2Path = PLAN_V2_PATH(tenantId, sessionId);
  await Bun.write(v2Path, v2Content);
  db.prepare('UPDATE brainstorm_sessions SET plan_v2_path = ? WHERE id = ?').run(v2Path, sessionId);

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

  const sumResp = await callLiteLLM(summaryPrompt, 'editorial-cloud-heavy', 2000);
  const sumContent = sumResp.choices[0]?.message?.content || '';
  const sumPath = SUMMARY_PATH(tenantId, sessionId);
  await Bun.write(sumPath, sumContent);
  db.prepare('UPDATE brainstorm_sessions SET summary_path = ? WHERE id = ?').run(sumPath, sessionId);

  broadcastBrainstormEvent(tenantId, sessionId, 'consolidation_done', {});
}

export async function createWorkflowFromSession(sessionId: string): Promise<string> {
  const db = getDashboardDb()!;
  const session = db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(sessionId) as any;
  if (!session) throw new Error("Session not found");

  // Dedup: if this session already produced a workflow that still exists, reuse it
  // instead of inserting a duplicate on repeated "create workflow" clicks.
  if (session.workflow_id) {
    const existing = db.prepare('SELECT id FROM builder_workflows WHERE id = ?').get(session.workflow_id) as any;
    if (existing) return session.workflow_id as string;
  }

  const workflowId = crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();

  // Build a config the runner can actually iterate on. 'brainstorm' was never a
  // valid BuilderWorkflowMode, so the runner treated it as single-pass; use
  // 'auto-continue' with a generous maxPasses so the build runs to plan-complete
  // (the loop self-stops once every "- [ ]" item in the plan is checked). The
  // workflow is created paused so the operator can review/adjust before launch.
  const derivedConfig = {
    ...DEFAULT_WORKFLOW_CONFIG,
    // 'existing' sessions carry codebase_path; 'new' apps leave this for the
    // operator to set via the workflow form's project picker before launch.
    projectRoot: session.codebase_path || DEFAULT_WORKFLOW_CONFIG.projectRoot,
    // Default to a free, verified OpenCode model; editable in the workflow form.
    agentOrder: ['opencode:opencode/nemotron-3-ultra-free'],
    riskPolicy: { ...DEFAULT_WORKFLOW_CONFIG.riskPolicy, maxPasses: 30 },
    gitPolicy: { commit: 'manual' as const, push: 'never' as const },
    backupPolicy: { enabled: true, beforeRun: true },
    description: session.description,
    specs: session.specs,
    source: 'brainstormer',
    sourceSessionId: sessionId,
  };

  db.prepare(`
    INSERT INTO builder_workflows (id, project_id, name, mode, status, plan_file, config_json, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workflowId,
    'brainstorm-derived',
    session.name,
    'auto-continue',
    'paused',
    session.plan_v2_path || '',
    JSON.stringify(derivedConfig),
    now,
    now,
    session.tenant_id || session.tenantId
  );

  db.prepare('UPDATE brainstorm_sessions SET workflow_id = ? WHERE id = ?').run(workflowId, sessionId);

  return workflowId;
}