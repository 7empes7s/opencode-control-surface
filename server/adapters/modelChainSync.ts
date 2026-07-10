import { readJsonFileAtomic } from "../lib/atomicJson.ts";
import { runShell } from "../api/shell.ts";

export const ROLE_TO_LOGICAL = {
  editorialHeavy: "editorial-heavy",
  editorialFast: "editorial-fast",
  editorialCloudHeavy: "editorial-cloud-heavy",
  editorialCloudFast: "editorial-cloud-fast",
} as const;

export const LITELLM_APPLY_COMMAND = 'sudo cp -a /etc/litellm/config.yaml /etc/litellm/config.yaml.bak-$(date +%Y%m%d-%H%M%S) && sudo systemctl reload litellm && sleep 2 && systemctl is-active litellm && curl -s http://127.0.0.1:4000/v1/models >/dev/null && echo "litellm reloaded OK"';

const CONFIG_READ_TIMEOUT_MS = 5_000;
const STALE_AFTER_SEC = 6 * 3600;

export type ChainRole = keyof typeof ROLE_TO_LOGICAL;

export interface ChainDiff {
  role: string;
  logicalName: string;
  current: string[] | null;
  proposed: string[];
  inSync: boolean;
  added: string[];
  removed: string[];
  reordered: boolean;
}

export interface ModelChainSyncPayload {
  generatedAt: number;
  healthAgeSec: number;
  stale: boolean;
  configReadError: boolean;
  anyChanges: boolean;
  chains: ChainDiff[];
  correctedYamlBlock: string;
  applyCommand: string;
}

interface ModelHealthFile {
  lastFullCheckAt?: number;
  fallbacks?: Record<string, unknown>;
}

type FallbackEntry = Record<string, string[]>;

function modelHealthPath(): string {
  return process.env.DASHBOARD_MODEL_HEALTH_PATH || "/var/lib/mimule/model-health.json";
}

function litellmConfigPath(): string {
  return process.env.DASHBOARD_LITELLM_CONFIG_PATH || "/etc/litellm/config.yaml";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizeFallbackEntries(value: unknown): FallbackEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: FallbackEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const normalized: FallbackEntry = {};
    for (const [key, chain] of Object.entries(item as Record<string, unknown>)) {
      if (isStringArray(chain)) normalized[key] = [...chain];
    }
    if (Object.keys(normalized).length > 0) entries.push(normalized);
  }
  return entries;
}

function flattenFallbackEntries(entries: FallbackEntry[]): Record<string, string[]> {
  const flattened: Record<string, string[]> = {};
  for (const entry of entries) {
    for (const [logicalName, chain] of Object.entries(entry)) {
      flattened[logicalName] = [...chain];
    }
  }
  return flattened;
}

export function readLiteLLMFallbacks(): { entries: FallbackEntry[]; flattened: Record<string, string[]>; configReadError: boolean } {
  const command = `python3 -c 'import yaml,json,sys; c=yaml.safe_load(open(sys.argv[1])) or {}; rs=c.get("router_settings") or {}; print(json.dumps(rs.get("fallbacks") or []))' ${shellQuote(litellmConfigPath())}`;
  const result = runShell(command, { timeout: CONFIG_READ_TIMEOUT_MS });
  if (!result.ok) {
    return { entries: [], flattened: {}, configReadError: true };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return { entries: [], flattened: {}, configReadError: true };
    const entries = normalizeFallbackEntries(parsed);
    return { entries, flattened: flattenFallbackEntries(entries), configReadError: false };
  } catch {
    return { entries: [], flattened: {}, configReadError: true };
  }
}

function arraysEqual(a: string[] | null, b: string[]): boolean {
  return a !== null && a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aSet = new Set(a);
  const bSet = new Set(b);
  return a.every((value) => bSet.has(value)) && b.every((value) => aSet.has(value));
}

export function computeChainDiff(role: ChainRole, current: string[] | null, proposed: string[]): ChainDiff {
  const currentList = current ?? [];
  const added = proposed.filter((model) => !currentList.includes(model));
  const removed = currentList.filter((model) => !proposed.includes(model));
  const inSync = arraysEqual(current, proposed);
  const reordered = current !== null && !inSync && added.length === 0 && removed.length === 0 && sameSet(current, proposed);
  return {
    role,
    logicalName: ROLE_TO_LOGICAL[role],
    current: current ? [...current] : null,
    proposed: [...proposed],
    inSync,
    added,
    removed,
    reordered,
  };
}

function readProposedHealthFallbacks(): { lastFullCheckAt: number; fallbacks: Partial<Record<ChainRole, string[]>> } {
  const health = readJsonFileAtomic<ModelHealthFile>(modelHealthPath(), { fallback: {} });
  const fallbacks: Partial<Record<ChainRole, string[]>> = {};
  for (const role of Object.keys(ROLE_TO_LOGICAL) as ChainRole[]) {
    const chain = health.fallbacks?.[role];
    if (isStringArray(chain)) fallbacks[role] = [...chain];
  }
  return {
    lastFullCheckAt: typeof health.lastFullCheckAt === "number" && Number.isFinite(health.lastFullCheckAt) ? health.lastFullCheckAt : 0,
    fallbacks,
  };
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

export function serializeFallbackBlock(entries: FallbackEntry[]): string {
  const lines = ["router_settings:", "  fallbacks:"];
  for (const entry of entries) {
    for (const [logicalName, chain] of Object.entries(entry)) {
      if (chain.length === 0) {
        lines.push(`    - ${yamlScalar(logicalName)}: []`);
      } else {
        lines.push(`    - ${yamlScalar(logicalName)}:`);
        for (const model of chain) {
          lines.push(`        - ${yamlScalar(model)}`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildCorrectedEntries(currentEntries: FallbackEntry[], proposed: Partial<Record<ChainRole, string[]>>): FallbackEntry[] {
  const replaced = new Set<string>();
  const next: FallbackEntry[] = [];
  for (const entry of currentEntries) {
    const out: FallbackEntry = {};
    for (const [logicalName, chain] of Object.entries(entry)) {
      const role = (Object.keys(ROLE_TO_LOGICAL) as ChainRole[]).find((candidate) => ROLE_TO_LOGICAL[candidate] === logicalName);
      if (role && proposed[role]) {
        out[logicalName] = [...proposed[role]];
        replaced.add(logicalName);
      } else {
        out[logicalName] = [...chain];
      }
    }
    next.push(out);
  }
  for (const role of Object.keys(ROLE_TO_LOGICAL) as ChainRole[]) {
    const chain = proposed[role];
    const logicalName = ROLE_TO_LOGICAL[role];
    if (chain && !replaced.has(logicalName)) next.push({ [logicalName]: [...chain] });
  }
  return next;
}

export function getModelChainSyncPayload(now = Date.now()): ModelChainSyncPayload {
  const health = readProposedHealthFallbacks();
  const config = readLiteLLMFallbacks();
  const chains = (Object.keys(ROLE_TO_LOGICAL) as ChainRole[])
    .filter((role) => health.fallbacks[role])
    .map((role) => computeChainDiff(role, config.flattened[ROLE_TO_LOGICAL[role]] ?? null, health.fallbacks[role] ?? []));
  const healthAgeSec = health.lastFullCheckAt > 0 ? Math.max(0, Math.floor((now - health.lastFullCheckAt) / 1000)) : 0;

  return {
    generatedAt: now,
    healthAgeSec,
    stale: healthAgeSec > STALE_AFTER_SEC,
    configReadError: config.configReadError,
    anyChanges: chains.some((chain) => !chain.inSync),
    chains,
    correctedYamlBlock: serializeFallbackBlock(buildCorrectedEntries(config.entries, health.fallbacks)),
    applyCommand: LITELLM_APPLY_COMMAND,
  };
}
