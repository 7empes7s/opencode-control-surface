import { execFileSync } from "node:child_process";

type PaperclipSource = "api" | "db" | "unavailable";

export type PaperclipAgent = {
  id: string;
  name: string;
  role: string | null;
  adapterType: string | null;
  command: string | null;
  model: string | null;
  status: string;
  lastRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export type PaperclipTask = {
  id: string;
  agentId: string | null;
  agentName: string | null;
  status: string;
  priority: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

type PaperclipAdapterHealth = {
  adapterType: string;
  totalAgents: number;
  activeAgents: number;
  errorAgents: number;
  statuses: Record<string, number>;
};

type PaperclipTaskSummary = {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
};

const DEFAULT_API_URL = "http://127.0.0.1:3100";
const DB_CONTAINER = process.env.PAPERCLIP_DB_CONTAINER ?? "paperclip_db";
const DB_USER = process.env.PAPERCLIP_DB_USER ?? "paperclip";
const DB_NAME = process.env.PAPERCLIP_DB_NAME ?? "paperclip";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json({ data }, init);
}

function getApiUrl(): string {
  return (process.env.PAPERCLIP_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
}

function getApiKey(): string | null {
  return process.env.PAPERCLIP_API_KEY || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function pickArray(body: unknown, keys: string[]): unknown[] {
  if (Array.isArray(body)) return body;
  const record = asRecord(body);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  const data = record.data;
  if (Array.isArray(data)) return data;
  const nested = asRecord(data);
  if (nested) {
    for (const key of keys) {
      const value = nested[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value != null) return value;
  }
  return null;
}

export function normalizePaperclipAgents(body: unknown): PaperclipAgent[] {
  return pickArray(body, ["agents", "items", "rows"]).map((entry, index) => {
    const record = asRecord(entry) ?? {};
    const adapterConfig = asRecord(record.adapter_config) ?? asRecord(record.adapterConfig) ?? {};
    return {
      id: firstString(record, ["id", "agent_id", "agentId", "uuid"]) ?? `agent-${index + 1}`,
      name: firstString(record, ["name", "agent_name", "agentName"]) ?? "Unknown agent",
      role: firstString(record, ["role", "description"]),
      adapterType: firstString(record, ["adapter_type", "adapterType", "adapter"]) ?? firstString(adapterConfig, ["type"]),
      command: firstString(record, ["command"]) ?? firstString(adapterConfig, ["command"]),
      model: firstString(record, ["model"]) ?? firstString(adapterConfig, ["model"]),
      status: firstString(record, ["status", "state"]) ?? "unknown",
      lastRunAt: firstString(record, ["last_run_at", "lastRunAt", "last_seen_at", "updated_at", "updatedAt"]),
      lastError: firstString(record, ["last_error", "lastError", "error"]),
      consecutiveFailures: asNumber(record.consecutive_failures ?? record.consecutiveFailures),
    };
  });
}

export function normalizePaperclipTasks(body: unknown): PaperclipTask[] {
  return pickArray(body, ["tasks", "runs", "items", "rows"]).map((entry, index) => {
    const record = asRecord(entry) ?? {};
    return {
      id: firstString(record, ["id", "task_id", "taskId", "run_id", "runId"]) ?? `task-${index + 1}`,
      agentId: firstString(record, ["agent_id", "agentId"]),
      agentName: firstString(record, ["agent_name", "agentName", "agent"]),
      status: firstString(record, ["status", "state"]) ?? "unknown",
      priority: firstString(record, ["priority"]),
      createdAt: firstString(record, ["created_at", "createdAt", "queued_at", "queuedAt"]),
      startedAt: firstString(record, ["started_at", "startedAt"]),
      finishedAt: firstString(record, ["finished_at", "finishedAt", "completed_at", "completedAt"]),
      error: firstString(record, ["error", "last_error", "lastError"]),
    };
  });
}

export function parsePaperclipAgentRows(raw: string): PaperclipAgent[] {
  return raw.split("\n").map((line, index) => {
    const [id, name, adapterType, command, model, status] = line.split("\t");
    if (!id || !name) return null;
    return {
      id,
      name,
      role: null,
      adapterType: adapterType || null,
      command: command || null,
      model: model || null,
      status: status || "unknown",
      lastRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
    } satisfies PaperclipAgent;
  }).filter((agent): agent is PaperclipAgent => agent != null);
}

export function parsePaperclipTaskRows(raw: string): PaperclipTask[] {
  return raw.split("\n").map((line, index) => {
    const [id, agentId, agentName, status, startedAt, finishedAt] = line.split("\t");
    if (!id) return null;
    return {
      id,
      agentId: agentId || null,
      agentName: agentName || null,
      status: status || "unknown",
      priority: null,
      createdAt: startedAt || null,
      startedAt: startedAt || null,
      finishedAt: finishedAt || null,
      error: null,
    } satisfies PaperclipTask;
  }).filter((task): task is PaperclipTask => task != null);
}

function summarizeAdapters(agents: PaperclipAgent[]): PaperclipAdapterHealth[] {
  const byAdapter = new Map<string, PaperclipAdapterHealth>();
  for (const agent of agents) {
    const adapterType = agent.adapterType ?? "unknown";
    const status = agent.status || "unknown";
    const current = byAdapter.get(adapterType) ?? {
      adapterType,
      totalAgents: 0,
      activeAgents: 0,
      errorAgents: 0,
      statuses: {},
    };
    current.totalAgents += 1;
    current.statuses[status] = (current.statuses[status] ?? 0) + 1;
    if (/error|failed|offline/i.test(status)) current.errorAgents += 1;
    if (/idle|busy|running|active|online|ok/i.test(status)) current.activeAgents += 1;
    byAdapter.set(adapterType, current);
  }
  return [...byAdapter.values()].sort((a, b) => a.adapterType.localeCompare(b.adapterType));
}

function summarizeTasks(tasks: PaperclipTask[]): PaperclipTaskSummary {
  const summary: PaperclipTaskSummary = { total: tasks.length, pending: 0, running: 0, completed: 0, failed: 0 };
  for (const task of tasks) {
    if (/pending|queued|waiting/i.test(task.status)) summary.pending += 1;
    else if (/running|active|started/i.test(task.status)) summary.running += 1;
    else if (/complete|success|done|finished/i.test(task.status)) summary.completed += 1;
    else if (/fail|error|cancel/i.test(task.status)) summary.failed += 1;
  }
  return summary;
}

async function fetchPaperclip(pathname: string): Promise<unknown> {
  const key = getApiKey();
  const response = await fetch(`${getApiUrl()}${pathname}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function queryPaperclipDb(sql: string): string {
  return execFileSync("docker", [
    "exec",
    "-i",
    DB_CONTAINER,
    "psql",
    "-U",
    DB_USER,
    "-d",
    DB_NAME,
    "-t",
    "-A",
    "-F",
    "\t",
    "-c",
    sql,
  ], { encoding: "utf8", timeout: 5000 }).trim();
}

function readAgentsFromDb(): PaperclipAgent[] {
  const raw = queryPaperclipDb(`
SELECT
  id::text,
  name,
  adapter_type,
  COALESCE(adapter_config->>'command', ''),
  COALESCE(adapter_config->>'model', ''),
  status
FROM agents
ORDER BY name;
`);
  return parsePaperclipAgentRows(raw);
}

function readTasksFromDb(): PaperclipTask[] {
  const raw = queryPaperclipDb(`
SELECT
  hr.id::text,
  hr.agent_id::text,
  COALESCE(a.name, ''),
  hr.status,
  COALESCE(hr.started_at::text, ''),
  COALESCE(hr.finished_at::text, '')
FROM heartbeat_runs hr
LEFT JOIN agents a ON a.id = hr.agent_id
ORDER BY hr.started_at DESC
LIMIT 100;
`);
  return parsePaperclipTaskRows(raw);
}

export async function paperclipAgentsHandler(): Promise<Response> {
  const errors: string[] = [];
  let source: PaperclipSource = "unavailable";
  let agents: PaperclipAgent[] = [];

  try {
    agents = normalizePaperclipAgents(await fetchPaperclip("/api/agents"));
    source = "api";
  } catch (error) {
    errors.push(`api: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (agents.length === 0) {
    try {
      agents = readAgentsFromDb();
      source = "db";
    } catch (error) {
      errors.push(`db: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return json({
    source,
    apiUrl: getApiUrl(),
    generatedAt: new Date().toISOString(),
    agents,
    adapterHealth: summarizeAdapters(agents),
    errors,
  });
}

export async function paperclipTasksHandler(): Promise<Response> {
  const errors: string[] = [];
  let source: PaperclipSource = "unavailable";
  let tasks: PaperclipTask[] = [];

  for (const pathname of ["/api/tasks", "/api/heartbeat-runs"]) {
    try {
      tasks = normalizePaperclipTasks(await fetchPaperclip(pathname));
      source = "api";
      if (tasks.length > 0) break;
    } catch (error) {
      errors.push(`${pathname}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (tasks.length === 0) {
    try {
      tasks = readTasksFromDb();
      source = "db";
    } catch (error) {
      errors.push(`db: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return json({
    source,
    apiUrl: getApiUrl(),
    generatedAt: new Date().toISOString(),
    tasks,
    summary: summarizeTasks(tasks),
    errors,
  });
}
