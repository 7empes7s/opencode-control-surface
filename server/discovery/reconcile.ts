import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getDashboardDb } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

export type DiscoveredAssetStatus = "unregistered" | "registered" | "ignored";
export type DiscoveredAssetKind =
  | "process"
  | "port"
  | "systemd"
  | "container"
  | "backend"
  | "cli"
  | "credential";

export type DiscoveredAssetInput = {
  kind: DiscoveredAssetKind;
  signature: string;
  sourceProbe: string;
  fingerprint: Record<string, unknown>;
};

export type DiscoveredAsset = DiscoveredAssetInput & {
  id: string;
  tenantId: string;
  firstSeen: number;
  lastSeen: number;
  status: DiscoveredAssetStatus;
  registeredName: string | null;
  owner: string | null;
  criticality: "low" | "medium" | "high" | "critical" | null;
  attachedService: string | null;
  ignoredReason: string | null;
  updatedAt: number;
};

type AssetRow = {
  id: string;
  tenant_id: string;
  kind: DiscoveredAssetKind;
  signature: string;
  source_probe: string;
  first_seen: number;
  last_seen: number;
  status: DiscoveredAssetStatus;
  fingerprint_json: string;
  registered_name: string | null;
  owner: string | null;
  criticality: DiscoveredAsset["criticality"];
  attached_service: string | null;
  ignored_reason: string | null;
  updated_at: number;
};

const AI_SIGNATURE = /\b(ollama|vllm|llama(?:-cpp|\.cpp)?|litellm|text-generation-inference|tgi|langflow|open-webui|aider|codex|claude|gemini|opencode|mcp|openai|anthropic|mistral|groq|together|perplexity|deepseek)\b/i;
const PROVIDER_KEY = /\b(OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|MISTRAL|GROQ|TOGETHER|PERPLEXITY|DEEPSEEK|OPENROUTER|HF|HUGGINGFACE)_[A-Z0-9_]*(?:API_)?KEY\b/;

function assetId(tenantId: string, kind: string, signature: string, sourceProbe: string): string {
  const digest = createHash("sha256")
    .update(`${tenantId}\0${kind}\0${signature}\0${sourceProbe}`)
    .digest("hex")
    .slice(0, 20);
  return `asset_${digest}`;
}

function normalizeSignature(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

const INTERPRETERS = new Set(["node", "bun", "python", "python3", "sh", "bash", "zsh", "npm", "npx", "bunx", "deno"]);

// Process identity must be stable across restarts and sessions. Raw cmdlines carry
// session ids, ports, and per-run paths, so hashing them creates a new "asset" for
// every invocation and floods the inbox. Collapse to: executable + script + the AI
// technologies matched. The latest full cmdline stays in the fingerprint as evidence.
export function stableProcessSignature(cmdline: string): string {
  const tokens = cmdline.split(" ").filter(Boolean);
  const argv0 = basename(tokens[0] ?? "unknown");
  let script = "";
  if (INTERPRETERS.has(argv0)) {
    const scriptToken = tokens.slice(1).find((token) => !token.startsWith("-"));
    if (scriptToken) script = basename(scriptToken);
  }
  const keywordMatches = cmdline.match(new RegExp(AI_SIGNATURE.source, "gi")) ?? [];
  const keywords = [...new Set(keywordMatches.map((keyword) => keyword.toLowerCase()))].sort();
  return normalizeSignature(`${argv0}${script ? ` ${script}` : ""} [${keywords.join("+")}]`);
}

function command(name: string, args: string[], timeout = 1500): string {
  try {
    return execFileSync(name, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function pushUnique(out: DiscoveredAssetInput[], input: DiscoveredAssetInput): void {
  const key = `${input.kind}\0${input.signature}\0${input.sourceProbe}`;
  if (out.some((item) => `${item.kind}\0${item.signature}\0${item.sourceProbe}` === key)) return;
  out.push(input);
}

export function discoverProcesses(procRoot = "/proc"): DiscoveredAssetInput[] {
  const out: DiscoveredAssetInput[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return out;
  }

  for (const pid of entries.slice(0, 2000)) {
    try {
      const raw = readFileSync(join(procRoot, pid, "cmdline"), "utf8");
      const cmdline = raw.replace(/\0/g, " ").trim();
      if (!cmdline || !AI_SIGNATURE.test(cmdline)) continue;
      pushUnique(out, {
        kind: "process",
        signature: stableProcessSignature(cmdline),
        sourceProbe: "proc-cmdline",
        fingerprint: { pid: Number(pid), cmdline: normalizeSignature(cmdline) },
      });
    } catch {
      // Processes can disappear while scanning.
    }
  }

  return out;
}

export function discoverListeningPorts(): DiscoveredAssetInput[] {
  const out: DiscoveredAssetInput[] = [];
  const raw = command("ss", ["-ltnp"]);
  for (const line of raw.split("\n")) {
    if (!line.includes("LISTEN")) continue;
    const processMatch = line.match(/users:\(\("([^"]+)"/);
    const localMatch = line.match(/\s(\S+):(\d+)\s+\S+\s*$/) ?? line.match(/\s(\S+):(\d+)\s+/);
    const processName = processMatch?.[1] ?? "";
    if (!AI_SIGNATURE.test(`${processName} ${line}`)) continue;
    const host = localMatch?.[1] ?? "unknown";
    const port = localMatch?.[2] ?? "unknown";
    const exposure = host === "0.0.0.0" || host === "[::]" || host === "*" ? "public-listener" : "local-listener";
    pushUnique(out, {
      kind: "port",
      signature: normalizeSignature(`${host}:${port}/${processName || "unknown"}`),
      sourceProbe: "ss-listen",
      fingerprint: { host, port: Number(port) || port, processName, exposure, raw: line.trim().slice(0, 500) },
    });
  }
  return out;
}

export function discoverSystemdUnits(): DiscoveredAssetInput[] {
  const out: DiscoveredAssetInput[] = [];
  const raw = command("systemctl", ["list-units", "--type=service", "--all", "--no-legend", "--no-pager"]);
  for (const line of raw.split("\n")) {
    if (!AI_SIGNATURE.test(line)) continue;
    const [unit, load, active, sub] = line.trim().split(/\s+/, 4);
    if (!unit) continue;
    pushUnique(out, {
      kind: "systemd",
      signature: normalizeSignature(unit),
      sourceProbe: "systemctl-list-units",
      fingerprint: { unit, load, active, sub, raw: line.trim().slice(0, 500) },
    });
  }
  return out;
}

export function discoverContainers(): DiscoveredAssetInput[] {
  const out: DiscoveredAssetInput[] = [];
  const raw = command("docker", ["ps", "--format", "{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Ports}}"], 2000);
  for (const line of raw.split("\n")) {
    if (!AI_SIGNATURE.test(line)) continue;
    const [id, image, name, ports] = line.split("\t");
    if (!id) continue;
    pushUnique(out, {
      kind: "container",
      signature: normalizeSignature(`${image || "unknown"}:${name || id}`),
      sourceProbe: "docker-ps",
      fingerprint: { containerId: id, image, name, ports },
    });
  }
  return out;
}

export function discoverBackendsFromEnv(env: NodeJS.ProcessEnv = process.env): DiscoveredAssetInput[] {
  const out: DiscoveredAssetInput[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/(^|_)(BASE_URL|API_URL|ENDPOINT|HOST)$/i.test(name)) continue;
    if (!AI_SIGNATURE.test(`${name} ${value}`) && !/\/v1\/?$/i.test(value)) continue;
    pushUnique(out, {
      kind: "backend",
      signature: normalizeSignature(`${name}=${value}`),
      sourceProbe: "env-backend-url",
      fingerprint: { env: name, url: value.replace(/[?#].*$/, "") },
    });
  }
  return out;
}

export function discoverCliTools(pathValue = process.env.PATH ?? ""): DiscoveredAssetInput[] {
  const out: DiscoveredAssetInput[] = [];
  const seen = new Set<string>();
  for (const dir of pathValue.split(":").filter(Boolean)) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.has(name) || !AI_SIGNATURE.test(name)) continue;
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      seen.add(name);
      pushUnique(out, {
        kind: "cli",
        signature: normalizeSignature(name),
        sourceProbe: "path-scan",
        fingerprint: { name, directory: dir },
      });
    }
  }
  return out;
}

export function discoverCredentials(env: NodeJS.ProcessEnv = process.env): DiscoveredAssetInput[] {
  const out: DiscoveredAssetInput[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || !PROVIDER_KEY.test(name)) continue;
    pushUnique(out, {
      kind: "credential",
      signature: normalizeSignature(name),
      sourceProbe: "env-key-presence",
      fingerprint: { env: name, location: "process.env", present: true, valueRedacted: true },
    });
  }
  return out;
}

export const DISCOVERY_SOURCES = {
  "proc-cmdline": discoverProcesses,
  "ss-listen": discoverListeningPorts,
  "systemctl-list-units": discoverSystemdUnits,
  "docker-ps": discoverContainers,
  "env-backend-url": discoverBackendsFromEnv,
  "path-scan": discoverCliTools,
  "env-key-presence": discoverCredentials,
} satisfies Record<string, () => DiscoveredAssetInput[]>;

export type DiscoverySource = keyof typeof DISCOVERY_SOURCES;

export function discoverAiAssets(): DiscoveredAssetInput[] {
  const out: DiscoveredAssetInput[] = [];
  const collect = (fn: () => DiscoveredAssetInput[]): void => {
    try {
      for (const asset of fn()) pushUnique(out, asset);
    } catch (err) {
      console.error("[discovery] probe failed", err instanceof Error ? err.message : err);
    }
  };

  for (const probe of Object.values(DISCOVERY_SOURCES)) collect(probe);

  return out;
}

function mapRow(row: AssetRow): DiscoveredAsset {
  let fingerprint: Record<string, unknown> = {};
  try {
    fingerprint = JSON.parse(row.fingerprint_json) as Record<string, unknown>;
  } catch {
    fingerprint = {};
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    signature: row.signature,
    sourceProbe: row.source_probe,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    status: row.status,
    fingerprint,
    registeredName: row.registered_name,
    owner: row.owner,
    criticality: row.criticality,
    attachedService: row.attached_service,
    ignoredReason: row.ignored_reason,
    updatedAt: row.updated_at,
  };
}

export function reconcileDiscoveredAssets(inputs: DiscoveredAssetInput[], now = Date.now()): DiscoveredAsset[] {
  const db = getDashboardDb();
  if (!db) return [];
  const tenantId = getCurrentTenantContext().tenantId;
  const rows: DiscoveredAsset[] = [];

  for (const input of inputs) {
    const signature = normalizeSignature(input.signature);
    if (!signature) continue;
    const id = assetId(tenantId, input.kind, signature, input.sourceProbe);
    db.query(`
      INSERT INTO discovered_assets
        (id, tenant_id, kind, signature, source_probe, first_seen, last_seen, status, fingerprint_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'unregistered', ?, ?)
      ON CONFLICT(tenant_id, kind, signature, source_probe) DO UPDATE SET
        last_seen = excluded.last_seen,
        fingerprint_json = excluded.fingerprint_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      tenantId,
      input.kind,
      signature,
      input.sourceProbe,
      now,
      now,
      JSON.stringify(input.fingerprint),
      now,
    );
  }

  const tenant = whereTenant();

  // Registry hygiene: unregistered assets that have not been seen for the retention
  // window are dropped (registered/ignored entries are operator decisions and kept).
  const retentionMs = Number(process.env.DISCOVERY_RETENTION_MS) || 30 * 24 * 60 * 60 * 1000;
  db.query(`
    DELETE FROM discovered_assets
    WHERE status = 'unregistered' AND last_seen < ? ${tenant.clause}
  `).run(now - retentionMs, ...tenant.params);

  const dbRows = db.query(`
    SELECT id, tenant_id, kind, signature, source_probe, first_seen, last_seen, status,
           fingerprint_json, registered_name, owner, criticality, attached_service,
           ignored_reason, updated_at
    FROM discovered_assets
    WHERE 1=1 ${tenant.clause}
    ORDER BY last_seen DESC
  `).all(...tenant.params) as AssetRow[];

  for (const row of dbRows) rows.push(mapRow(row));
  return rows;
}

export function listDiscoveredAssets(status?: DiscoveredAssetStatus): DiscoveredAsset[] {
  const db = getDashboardDb();
  if (!db) return [];
  const tenant = whereTenant();
  const params: string[] = [...tenant.params];
  let sql = `
    SELECT id, tenant_id, kind, signature, source_probe, first_seen, last_seen, status,
           fingerprint_json, registered_name, owner, criticality, attached_service,
           ignored_reason, updated_at
    FROM discovered_assets
    WHERE 1=1 ${tenant.clause}
  `;
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY last_seen DESC";
  return (db.query(sql).all(...params) as AssetRow[]).map(mapRow);
}

export function getAssetDisplayName(asset: DiscoveredAsset): string {
  const fp = asset.fingerprint;
  const name = fp.name ?? fp.processName ?? fp.unit ?? fp.image ?? fp.env ?? basename(asset.signature);
  return typeof name === "string" && name.trim() ? name.trim() : asset.signature;
}
