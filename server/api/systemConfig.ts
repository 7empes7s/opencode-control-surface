import { ok, type ApiEnvelope, type SystemConfig, type SystemConfigHistory } from './types.ts';
import { getDashboardDb, isDashboardDbEnabled } from '../db/dashboard.ts';

const CONFIG_KEY = "system_config";

const DEFAULT_CONFIG: SystemConfig["config"] = {
  financeAgent: {
    enabled: true,
    modelOverride: '',
    processingTimeout: 300000
  },
  pipelineStages: {
    research: { model: 'editorial-cloud-heavy', enabled: true, timeout: 600000 },
    write: { model: 'editorial-cloud-heavy', enabled: true, timeout: 600000 },
    publishPrep: { model: 'editorial-cloud-fast', enabled: true, timeout: 300000 },
    verify: { model: 'editorial-heavy', enabled: true, timeout: 600000 },
    scout: { model: 'editorial-fast', enabled: true, timeout: 300000 },
    rank: { model: 'editorial-fast', enabled: true, timeout: 300000 }
  },
  alertThresholds: {
    pipelineFailureRate: 0.1,
    modelResponseTimeMs: 30000,
    gpuUtilization: 0.8
  },
  autoPublish: {
    enabled: true,
    verticals: ['ai', 'trends', 'science', 'finance', 'global-politics', 'healthcare', 'culture', 'energy', 'climate', 'cybersecurity', 'economy', 'crypto'],
    approvalRequired: ['world', 'politics', 'business', 'technology']
  },
  approvalWorkflows: {
    enabled: true,
    requiredVerticals: ['world', 'politics', 'sensitive'],
    maxArticlesPerDay: 10
  }
};

function loadConfig(): SystemConfig["config"] {
  const db = getDashboardDb();
  if (!db) return DEFAULT_CONFIG;
  try {
    const row = db.query<{ value_json: string }, [string]>(
      "SELECT value_json FROM system_configs WHERE key = ?"
    ).get(CONFIG_KEY);
    if (!row) return DEFAULT_CONFIG;
    return JSON.parse(row.value_json);
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: SystemConfig["config"], changedBy: string, note?: string): void {
  const db = getDashboardDb();
  if (!db) return;
  const now = Date.now();
  const newJson = JSON.stringify(config);

  // Read existing value for diff
  let oldJson: string | null = null;
  try {
    const existing = db.query<{ value_json: string }, [string]>(
      "SELECT value_json FROM system_configs WHERE key = ?"
    ).get(CONFIG_KEY);
    oldJson = existing?.value_json ?? null;
  } catch { /* ignore */ }

  db.query("INSERT OR REPLACE INTO system_configs (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)")
    .run(CONFIG_KEY, newJson, now, changedBy);

  db.query(
    "INSERT INTO config_changes (ts, key, old_value_json, new_value_json, changed_by, note) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(now, CONFIG_KEY, oldJson, newJson, changedBy, note ?? null);
}

// Get current system configuration
export async function getSystemConfig(_req: Request): Promise<Response> {
  try {
    const config = loadConfig();
    const envelope: ApiEnvelope<SystemConfig> = ok({ config }, {});
    return new Response(JSON.stringify(envelope), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error('Error fetching system config:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch system config' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Update system configuration — persisted to system_configs + audited in config_changes
export async function updateSystemConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { config, note } = body;
    if (!config || typeof config !== 'object') {
      return new Response(JSON.stringify({ error: 'Missing config object' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    saveConfig(config, 'operator', note);

    const envelope: ApiEnvelope<any> = ok({
      success: true,
      config,
      message: 'Configuration saved successfully'
    }, {});
    return new Response(JSON.stringify(envelope), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error('Error updating system config:', error);
    return new Response(JSON.stringify({ error: 'Failed to update system config' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Get system configuration history from config_changes table
export async function getSystemConfigHistory(_req: Request): Promise<Response> {
  try {
    const db = isDashboardDbEnabled() ? getDashboardDb() : null;
    let history: SystemConfigHistory[] = [];

    if (db) {
      try {
        const rows = db.query<{
          id: number;
          ts: number;
          old_value_json: string | null;
          new_value_json: string;
          changed_by: string;
          note: string | null;
        }, [string]>(
          "SELECT id, ts, old_value_json, new_value_json, changed_by, note FROM config_changes WHERE key = ? ORDER BY ts DESC LIMIT 50"
        ).all(CONFIG_KEY);

        history = rows.map((r) => {
          let oldSnap: Record<string, unknown> = {};
          let newSnap: Record<string, unknown> = {};
          try { oldSnap = r.old_value_json ? JSON.parse(r.old_value_json) : {}; } catch { /* ignore */ }
          try { newSnap = JSON.parse(r.new_value_json); } catch { /* ignore */ }

          // Build a human-readable diff of top-level keys
          const changes: string[] = [];
          const allKeys = new Set([...Object.keys(oldSnap), ...Object.keys(newSnap)]);
          for (const key of allKeys) {
            if (JSON.stringify(oldSnap[key]) !== JSON.stringify(newSnap[key])) {
              changes.push(`Updated ${key}`);
            }
          }

          return {
            id: String(r.id),
            timestamp: new Date(r.ts).toISOString(),
            changedBy: r.changed_by,
            changes: changes.length > 0 ? changes : [r.note ?? 'Config saved'],
            configSnapshot: newSnap,
          };
        });
      } catch (err) {
        console.warn('config_changes query failed (table may not exist yet):', err);
      }
    }

    const envelope: ApiEnvelope<{ history: SystemConfigHistory[] }> = ok({ history }, {});
    return new Response(JSON.stringify(envelope), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error('Error fetching system config history:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch system config history' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
