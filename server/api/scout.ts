import fs from 'fs/promises';
import path from 'path';
import { ok, type ApiEnvelope, type ScoutRun } from './types.ts';

// Check if a file exists
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Get all scout runs
export async function getScoutRuns(_req: Request): Promise<Response> {
  try {
    const scoutRunsDir = '/var/lib/mimule/scout-runs';
    
    // Check if directory exists
    if (!(await fileExists(scoutRunsDir))) {
      const envelope: ApiEnvelope<{ runs: ScoutRun[] }> = ok({ runs: [] }, {});
      return new Response(JSON.stringify(envelope), { 
        headers: { "Content-Type": "application/json" } 
      });
    }

    // Read all JSON files in the directory
    const files = await fs.readdir(scoutRunsDir);
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    
    const runs: ScoutRun[] = [];
    for (const file of jsonFiles) {
      try {
        const filePath = path.join(scoutRunsDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const runData = JSON.parse(content);
        
        // Extract run ID from filename (YYYYMMDDTHHMMSSZ.json)
        const runId = file.replace('.json', '');
        
        runs.push({
          id: runId,
          ...runData
        });
      } catch (error) {
        console.error(`Error reading scout run file ${file}:`, error);
        continue;
      }
    }

    // Sort by runAt (most recent first)
    runs.sort((a, b) => new Date(b.runAt).getTime() - new Date(a.runAt).getTime());

    const envelope: ApiEnvelope<{ runs: ScoutRun[] }> = ok({ runs }, {});
    return new Response(JSON.stringify(envelope), { 
      headers: { "Content-Type": "application/json" } 
    });
  } catch (error) {
    console.error('Error fetching scout runs:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch scout runs' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Get specific scout run
export async function getScoutRun(_req: Request, runId: string): Promise<Response> {
  try {
    const scoutRunsDir = '/var/lib/mimule/scout-runs';
    const filePath = path.join(scoutRunsDir, `${runId}.json`);

    if (!(await fileExists(filePath))) {
      return new Response(JSON.stringify({ error: 'Scout run not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const runData = JSON.parse(content);

    const envelope: ApiEnvelope<any> = ok({
      id: runId,
      ...runData
    }, {});
    return new Response(JSON.stringify(envelope), { 
      headers: { "Content-Type": "application/json" } 
    });
  } catch (error) {
    console.error('Error fetching scout run:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch scout run' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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