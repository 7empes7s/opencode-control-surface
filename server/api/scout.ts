import fs from 'fs/promises';
import path from 'path';
import { ok, type ApiEnvelope, type ScoutRun } from './types.ts';

// Real scout runs live in the autopipeline's runs/ directory
const RUNS_ROOT = '/opt/mimoun/openclaw-config/workspace/newsbites_editorial/runs';

async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

// Map a deduped.json payload to the ScoutRun shape the UI expects
function dedupedToScoutRun(dateDir: string, tsDir: string, deduped: any): ScoutRun {
  const maxScore = Math.max(20, ...( deduped.items ?? []).map((i: any) => i.score ?? 0));

  const selected: any[] = (deduped.items ?? []).map((item: any) => ({
    headline: item.title ?? '',
    vertical: item.vertical ?? '',
    source: item.sourceName ?? item.sourceId ?? '',
    recencyScore: Math.min(1, (item.score ?? 0) / maxScore),
    noveltyScore: Math.min(1, (item.score ?? 0) / maxScore),
    finalScore: item.score ?? 0,
    selected: true,
    reason: 'selected',
  }));

  const dropped: any[] = (deduped.dropped ?? []).map((item: any) => ({
    headline: item.title ?? '',
    vertical: '',
    source: '',
    recencyScore: 0,
    noveltyScore: 0,
    finalScore: 0,
    selected: false,
    reason: item.reason ?? 'dropped',
  }));

  return {
    id: `${dateDir}/${tsDir}`,
    runAt: deduped.generatedAt ?? `${dateDir}T${tsDir.slice(9)}Z`,
    trigger: 'scheduled',
    topics: [...selected, ...dropped],
    queued: [],
    config: {},
  };
}

// Walk RUNS_ROOT/<date>/<timestamp>/deduped.json — last 30 days, most recent first
async function loadAllRuns(limit = 50): Promise<ScoutRun[]> {
  if (!(await fileExists(RUNS_ROOT))) return [];

  const dateDirs = (await fs.readdir(RUNS_ROOT)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 30);
  const runs: ScoutRun[] = [];

  for (const dateDir of dateDirs) {
    if (runs.length >= limit) break;
    const datePath = path.join(RUNS_ROOT, dateDir);
    let tsDirs: string[];
    try { tsDirs = (await fs.readdir(datePath)).sort().reverse(); } catch { continue; }
    for (const tsDir of tsDirs) {
      if (runs.length >= limit) break;
      const dedupedPath = path.join(datePath, tsDir, 'deduped.json');
      try {
        const deduped = JSON.parse(await fs.readFile(dedupedPath, 'utf-8'));
        runs.push(dedupedToScoutRun(dateDir, tsDir, deduped));
      } catch { continue; }
    }
  }

  return runs;
}

export async function getScoutRuns(_req: Request): Promise<Response> {
  try {
    const runs = await loadAllRuns();
    return new Response(JSON.stringify(ok({ runs }, {})), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch scout runs' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export async function getScoutRun(_req: Request, runId: string): Promise<Response> {
  // runId is "<date>/<tsDir>" — url-encoded slash arrives as %2F, already decoded by router
  const [dateDir, tsDir] = runId.split('/');
  if (!dateDir || !tsDir) {
    return new Response(JSON.stringify({ error: 'Invalid run ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const dedupedPath = path.join(RUNS_ROOT, dateDir, tsDir, 'deduped.json');
  try {
    const deduped = JSON.parse(await fs.readFile(dedupedPath, 'utf-8'));
    const run = dedupedToScoutRun(dateDir, tsDir, deduped);
    return new Response(JSON.stringify(ok(run, {})), { headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ error: 'Scout run not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
}

// Get scout configuration
export async function getScoutConfig(_req: Request): Promise<Response> {
  try {
    // This would typically connect to a database to get the config
    // For now, return a default configuration
    const defaultConfig = {
      enabled: true,
      frequency: 'every 4 hours',
      verticals: ['ai', 'finance', 'global-politics', 'trends', 'science'],
      maxTopicsPerRun: 10,
      minNoveltyScore: 0.7,
      minRecencyHours: 24,
      autoQueueThreshold: 0.8
    };

    const envelope: ApiEnvelope<any> = ok(defaultConfig, {});
    return new Response(JSON.stringify(envelope), { 
      headers: { "Content-Type": "application/json" } 
    });
  } catch (error) {
    console.error('Error fetching scout config:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch scout config' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Update scout configuration
export async function updateScoutConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const config = body;

    // In a real implementation, this would save to a database
    // For now, just validate and return the config
    
    // TODO: Actually persist the config in a database or config file
    console.log('Updating scout config:', config);

    const envelope: ApiEnvelope<any> = ok({ success: true, config }, {});
    return new Response(JSON.stringify(envelope), { 
      headers: { "Content-Type": "application/json" } 
    });
  } catch (error) {
    console.error('Error updating scout config:', error);
    return new Response(JSON.stringify({ error: 'Failed to update scout config' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Trigger a new scout run
export async function triggerScoutRun(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { reason = "Manual trigger" } = body;

    // In a real implementation, this would trigger the scout script
    // For now, just return a success response
    console.log('Triggering scout run:', reason);

    const envelope: ApiEnvelope<any> = ok({ 
      success: true, 
      message: 'Scout run triggered successfully',
      reason,
      timestamp: new Date().toISOString()
    }, {});
    return new Response(JSON.stringify(envelope), { 
      headers: { "Content-Type": "application/json" } 
    });
  } catch (error) {
    console.error('Error triggering scout run:', error);
    return new Response(JSON.stringify({ error: 'Failed to trigger scout run' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}