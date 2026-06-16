import { Hono } from 'hono';
import { checkToken } from './actions.ts';
import { existsSync } from 'node:fs';

const app = new Hono();

// ── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredProject {
  name: string;
  path: string;
  tech: string[];
  description: string;
  lastCommit: string | null;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SelectedProject {
  name: string;
  path: string;
  tech: string[];
  description: string;
}

// ── In-memory discover cache (5 min) ─────────────────────────────────────────

let discoverCache: { ts: number; projects: DiscoveredProject[] } | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectTech(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): string[] {
  const all = { ...deps, ...devDeps };
  const tags: string[] = [];
  if (all['next']) tags.push('Next.js');
  if (all['react']) tags.push('React');
  if (all['vue']) tags.push('Vue');
  if (all['svelte']) tags.push('Svelte');
  if (all['express']) tags.push('Express');
  if (all['hono']) tags.push('Hono');
  if (all['fastapi'] || all['flask'] || all['django']) tags.push('Python');
  if (all['bun']) tags.push('Bun');
  if (all['typescript'] || all['ts-node']) tags.push('TypeScript');
  if (all['prisma']) tags.push('Prisma');
  if (all['drizzle-orm']) tags.push('Drizzle');
  if (all['tailwindcss']) tags.push('Tailwind');
  return tags;
}

async function discoverProjects(): Promise<DiscoveredProject[]> {
  const now = Date.now();
  if (discoverCache && now - discoverCache.ts < 5 * 60 * 1000) {
    return discoverCache.projects;
  }

  const scanDirs = ['/opt', '/home/agent', '/root'];
  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();

  for (const scanDir of scanDirs) {
    if (!existsSync(scanDir)) continue;
    try {
      const proc = Bun.spawn(['find', scanDir, '-maxdepth', '4', '-name', '.git', '-type', 'd'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const raw = await new Response(proc.stdout).text();
      const gitDirs = raw.trim().split('\n').filter(Boolean);

      for (const gitDir of gitDirs) {
        const projectDir = gitDir.replace(/\/\.git$/, '');
        if (seen.has(projectDir)) continue;
        seen.add(projectDir);

        // Skip hidden dirs, scan roots themselves, provisioned/tmp dirs
        const basename = projectDir.split('/').pop() ?? '';
        if (basename.startsWith('.') || ['node_modules', 'vendor', '.npm', '.cache', '.bun'].includes(basename)) continue;
        if (scanDirs.includes(projectDir)) continue;
        if (projectDir.includes('/.codex/') || projectDir.includes('/provisioned/')) continue;

        let tech: string[] = [];
        let description = '';

        // Try package.json
        try {
          const pkg = JSON.parse(await Bun.file(`${projectDir}/package.json`).text());
          description = pkg.description || '';
          tech = detectTech(pkg.dependencies, pkg.devDependencies);
          if (!tech.includes('TypeScript') && pkg.devDependencies?.typescript) tech.push('TypeScript');
        } catch {}

        // Try pyproject.toml or go.mod as fallback tech detection
        if (tech.length === 0) {
          if (existsSync(`${projectDir}/pyproject.toml`)) tech.push('Python');
          else if (existsSync(`${projectDir}/go.mod`)) tech.push('Go');
          else if (existsSync(`${projectDir}/Cargo.toml`)) tech.push('Rust');
        }

        // Try README for description fallback
        if (!description) {
          for (const rf of ['README.md', 'README']) {
            try {
              const readme = await Bun.file(`${projectDir}/${rf}`).text();
              const firstLine = readme.split('\n').find(l => l.trim() && !l.startsWith('#'));
              if (firstLine) description = firstLine.slice(0, 120);
              break;
            } catch {}
          }
        }

        // Last commit timestamp
        let lastCommit: string | null = null;
        try {
          const cp = Bun.spawn(['git', '-C', projectDir, 'log', '-1', '--format=%cI'], { stdout: 'pipe', stderr: 'pipe' });
          lastCommit = (await new Response(cp.stdout).text()).trim() || null;
        } catch {}

        projects.push({ name: basename, path: projectDir, tech, description, lastCommit });
      }
    } catch {}
  }

  // Sort by last commit descending
  projects.sort((a, b) => {
    if (!a.lastCommit && !b.lastCommit) return 0;
    if (!a.lastCommit) return 1;
    if (!b.lastCommit) return -1;
    return b.lastCommit.localeCompare(a.lastCommit);
  });

  discoverCache = { ts: now, projects };
  return projects;
}

async function callLiteLLM(messages: Array<{role: string; content: string}>, maxTokens = 1000): Promise<string> {
  const litellmUrl = process.env.LITELLM_URL || 'http://127.0.0.1:4000';
  const masterKey = process.env.LITELLM_MASTER_KEY;

  const res = await fetch(`${litellmUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(masterKey ? { Authorization: `Bearer ${masterKey}` } : {}),
    },
    body: JSON.stringify({
      model: 'editorial-cloud-heavy',
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LiteLLM error ${res.status}: ${err}`);
  }

  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function buildSystemPrompt(selectedProject?: SelectedProject): string {
  const projectBlock = selectedProject
    ? `\nThe user has selected an existing project to work on:
- Name: ${selectedProject.name}
- Path: ${selectedProject.path}
- Tech stack: ${selectedProject.tech.join(', ') || 'unknown'}
- Description: ${selectedProject.description || 'none provided'}

When relevant, acknowledge this context. Any new work should integrate with this project.`
    : '';

  return `You are a friendly technical planning assistant helping a user clarify what they want to build before starting a detailed AI planning session.

Your goal is to ask focused questions to understand:
- What they want to build (the core feature or idea)
- Who it's for and why it matters
- Whether this is a new project or an addition to something existing
- Key constraints (tech preferences, integrations, timeline)
${projectBlock}

Be conversational and concise. Ask 1-2 questions at a time. Don't overwhelm. When you feel you have enough context to write a solid brief, say: "I think I have enough — shall I generate your planning brief?"`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/discover', async (c) => {
  if (!checkToken(c.req.raw)) return c.json({ error: 'Unauthorized' }, 401);
  const projects = await discoverProjects();
  return c.json({ projects });
});

app.post('/chat', async (c) => {
  if (!checkToken(c.req.raw)) return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json() as {
    messages: ChatMessage[];
    selectedProject?: SelectedProject;
  };

  const systemPrompt = buildSystemPrompt(body.selectedProject);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...body.messages,
  ];

  const reply = await callLiteLLM(messages, 800);
  return c.json({ reply });
});

app.post('/finalize', async (c) => {
  if (!checkToken(c.req.raw)) return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json() as {
    messages: ChatMessage[];
    selectedProject?: SelectedProject;
  };

  const conversationText = body.messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const projectHint = body.selectedProject
    ? `\nSelected project: ${body.selectedProject.name} at ${body.selectedProject.path} (${body.selectedProject.tech.join(', ')})`
    : '';

  const finalizeMessages = [
    {
      role: 'system',
      content: `Based on the conversation, extract a structured planning brief. Output ONLY valid JSON with this exact structure — no extra text:
{
  "name": "short descriptive name (max 60 chars)",
  "description": "clear description of what to build (2-4 sentences)",
  "specs": "technical specs, constraints, or requirements mentioned (or empty string)",
  "project_mode": "new" or "existing",
  "codebase_path": "/path/to/project (only if project_mode is existing, omit otherwise)"
}${projectHint}`,
    },
    { role: 'user', content: `Here is the conversation:\n${conversationText}\n\nExtract the brief now.` },
  ];

  const raw = await callLiteLLM(finalizeMessages, 600);

  // Parse JSON — strip any markdown fences
  const jsonStr = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  let brief: any;
  try {
    brief = JSON.parse(jsonStr);
  } catch {
    return c.json({ error: 'Failed to parse brief', raw }, 500);
  }

  return c.json(brief);
});

export default app;
