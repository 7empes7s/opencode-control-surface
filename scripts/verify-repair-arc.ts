#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_DASHBOARD_DB_PATH } from "../server/db/dashboard.ts";
import {
  R0_CUTOFF_MS,
  R1_ACCEPTANCE_START_MS,
  R2_RECENT_WINDOW_MS,
  exitCodeForOverall,
  overallFromChecks,
  sanitizeError,
  sanitizeForEvidence,
  verifyRepairArc,
  type GatewayCallRow,
  type CheckResult,
  type R1HistoryEntry,
  type R1FailureObservation,
  type R1Input,
  type R1Observation,
  type R2Input,
  type R2LiveModeEvidence,
  type R2Route,
  type R2ShadowObservation,
  type RepairArcInput,
  type RepairArcReport,
  type ValidationObservation,
  type WorkRunObservation,
} from "../server/api/repairArcVerify.ts";

const DEFAULT_EVIDENCE_DIR = "/var/lib/control-surface/repair-arc-evidence";
const DEFAULT_REPROBE_PATH = "/var/lib/mimule/model-fallback-reprobe.json";
const DEFAULT_MODEL_HEALTH_PATH = "/var/lib/mimule/model-health.json";
const DEFAULT_LITELLM_CONFIG_PATH = "/etc/litellm/config.yaml";
const DEFAULT_GATEWAY_CONFIG_PATH = "/etc/tib-builder/gateway.yaml";
const SCHEMA_VERSION = 2;
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const HTTP_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_FIXED_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_GLOBAL_EVIDENCE_ARTIFACTS = 4_096;
const MAX_CANDIDATE_EVIDENCE_ARTIFACTS = 128;
const WRITER_LOCK_STALE_MS = 15 * 60 * 1_000;
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const require = createRequire(import.meta.url);
const { load: loadYaml, JSON_SCHEMA: YAML_JSON_SCHEMA } = require("js-yaml") as {
  load: (source: string, options?: { schema?: unknown }) => unknown;
  JSON_SCHEMA: unknown;
};
const REQUIRED_CHECK_IDS = new Set([
  "r0.trace_coverage", "r0.request_outcomes", "evidence.history", "r1.stability",
  "r2.reconciliation", "r2.exact_429", "r2.outcome_delta", "r3.api_contract",
  "classifier.contract", "validation.bounded", "r3.ui_contract", "fresh_host.api_only",
  "live.surface", "r6.editorial", "r6.builder", "r4.disposition", "r5.disposition", "acceptance.log",
]);

function withinDefaultEvidenceRoot(path: string): boolean {
  const root = resolve(DEFAULT_EVIDENCE_DIR);
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export interface CliOptions {
  baseUrl?: string;
  evidenceDir: string;
  operatorInput?: string;
  help: boolean;
}

interface ValidationManifestPointer {
  manifestPath: string;
  manifestSha256: string;
}

type OperatorPayload = Omit<Partial<RepairArcInput>, "validation" | "r2"> & {
  validation?: ValidationManifestPointer;
  r2?: Partial<R2Input>;
};

export interface EvidenceEnvelope {
  schemaVersion: number;
  generatedAt: number;
  generatedAtUtc: string;
  sourceCommits: Record<string, string | null>;
  sourceClean: { controlSurface: boolean; mimounReprobe: boolean };
  cutoffs: Record<string, number>;
  queryWindows: Record<string, { from: number | null; to: number }>;
  observations: {
    r1Current: R1Observation | null;
    r2Current: R2ShadowObservation | null;
    r1Failures: R1FailureObservation[];
  };
  report: RepairArcReport;
}

class CliArgumentError extends Error {}

function usage(): string {
  return [
    "Usage: bun run scripts/verify-repair-arc.ts [options]",
    "",
    "Options:",
    "  --base-url <url>          Optional live control-surface origin.",
    "  --operator-input <path>   Optional JSON with R2/R4/R5/R6 observations.",
    `  --evidence-dir <path>     Evidence directory (default: ${DEFAULT_EVIDENCE_DIR}).`,
    "  --help                    Show this help.",
    "",
    "Authentication is read only from OPERATOR_TOKEN; tokens are never accepted as arguments.",
  ].join("\n");
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { evidenceDir: DEFAULT_EVIDENCE_DIR, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--base-url" || arg === "--evidence-dir" || arg === "--operator-input") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new CliArgumentError(`${arg} requires a value`);
      index += 1;
      if (arg === "--base-url") {
        let parsed: URL;
        try { parsed = new URL(value); } catch { throw new CliArgumentError("--base-url must be a valid URL"); }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new CliArgumentError("--base-url must use http or https");
        if (parsed.username || parsed.password) throw new CliArgumentError("--base-url must not contain userinfo credentials");
        if (parsed.search || parsed.hash) throw new CliArgumentError("--base-url must not contain a query or fragment");
        if (parsed.pathname !== "/" && parsed.pathname !== "") throw new CliArgumentError("--base-url must be an origin without a path");
        if (parsed.origin !== "http://127.0.0.1:3000") {
          throw new CliArgumentError("--base-url must be the canonical control-surface origin http://127.0.0.1:3000");
        }
        parsed.pathname = parsed.pathname.replace(/\/+$/, "");
        parsed.search = "";
        parsed.hash = "";
        options.baseUrl = parsed.toString().replace(/\/$/, "");
      } else if (arg === "--evidence-dir") {
        const evidenceDir = resolve(value);
        if (evidenceDir !== resolve(DEFAULT_EVIDENCE_DIR)) {
          throw new CliArgumentError(`--evidence-dir must be exactly ${DEFAULT_EVIDENCE_DIR}`);
        }
        options.evidenceDir = evidenceDir;
      }
      else options.operatorInput = resolve(value);
      continue;
    }
    throw new CliArgumentError(`unknown argument: ${arg}`);
  }
  return options;
}

function safeJsonParse(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function readBoundedRegularFile(path: string, maxBytes: number, label: string): Buffer {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) {
      throw new Error(`${label} is not a bounded regular file`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== before.size) {
      throw new Error(`${label} changed during its stable read`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function readJson(path: string, maxBytes = MAX_EVIDENCE_ARTIFACT_BYTES): unknown {
  return safeJsonParse(readBoundedRegularFile(path, maxBytes, "JSON input").toString("utf8"));
}

function fixedCommand(args: string[]): { ok: boolean; stdout: string; error?: string } {
  try {
    const proc = Bun.spawnSync({
      cmd: args,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
    const stdout = proc.stdout.toString();
    if (proc.exitCode !== 0) {
      const suffix = proc.signalCode === "SIGTERM" ? " or exceeded its resource bound" : "";
      return { ok: false, stdout, error: `command ${basename(args[0] ?? "unknown")} exited ${proc.exitCode}${suffix}` };
    }
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: "", error: sanitizeError(error) };
  }
}

function gitCommit(path: string): string | null {
  const command = fixedCommand(["git", "-C", path, "rev-parse", "HEAD"]);
  const value = command.stdout.trim();
  return command.ok && /^[a-f0-9]{40}$/i.test(value) ? value : null;
}

function gitTree(path: string): string | null {
  const command = fixedCommand(["git", "-C", path, "rev-parse", "HEAD^{tree}"]);
  const value = command.stdout.trim();
  return command.ok && /^[a-f0-9]{40}$/i.test(value) ? value : null;
}

function queryGatewayRows(db: Database, cutoff: number | undefined, ceiling: number): GatewayCallRow[] {
  const where = cutoff === undefined ? "WHERE ts <= ?" : "WHERE ts >= ? AND ts <= ?";
  const sql = `
    SELECT id, ts, logical_model, resolved_model, backend,
           success, latency_ms, error_class, trace_id, caller, tenant_id
    FROM gateway_calls
    ${where}
    ORDER BY ts ASC, id ASC
  `;
  type Row = GatewayCallRow;
  return cutoff === undefined
    ? db.query<Row, [number]>(sql).all(ceiling)
    : db.query<Row, [number, number]>(sql).all(cutoff, ceiling);
}

function readLedger(now: number): { r0Rows?: GatewayCallRow[]; r2Rows?: GatewayCallRow[]; error?: string } {
  let db: Database | null = null;
  try {
    db = new Database(DEFAULT_DASHBOARD_DB_PATH, { readonly: true, create: false });
    db.exec("PRAGMA query_only = ON");
    db.exec("BEGIN");
    const ledgerCount = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM gateway_calls").get()?.count ?? 0;
    if (!Number.isInteger(ledgerCount) || ledgerCount < 0 || ledgerCount > 100_000) {
      throw new Error("gateway ledger exceeds the verifier's 100000-row bounded read; archive or add a reviewed aggregate reader");
    }
    const textLengths = db.query<Record<string, number | null>, []>(`
      SELECT MAX(length(logical_model)) AS logical_model,
             MAX(length(resolved_model)) AS resolved_model,
             MAX(length(backend)) AS backend,
             MAX(length(error_class)) AS error_class,
             MAX(length(trace_id)) AS trace_id,
             MAX(length(caller)) AS caller,
             MAX(length(tenant_id)) AS tenant_id
      FROM gateway_calls
    `).get() ?? {};
    if (Object.entries(textLengths).some(([, length]) => length !== null && (!Number.isInteger(length) || length < 0 || length > 512))) {
      throw new Error("gateway ledger contains an oversized text identity; archive or repair it before verification");
    }
    const result = { r0Rows: queryGatewayRows(db, R0_CUTOFF_MS, now), r2Rows: queryGatewayRows(db, undefined, now) };
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db?.exec("ROLLBACK"); } catch { /* no active snapshot */ }
    return { error: sanitizeError(error) };
  } finally {
    db?.close();
  }
}

function sha256File(path: string): string | undefined {
  try { return createHash("sha256").update(readBoundedRegularFile(path, MAX_FIXED_INPUT_BYTES, "routing config")).digest("hex"); }
  catch { return undefined; }
}

function collectManagedChains(): { available: boolean; chains: Record<string, string[]>; error?: string } {
  try {
    const litellm = loadYaml(readBoundedRegularFile(DEFAULT_LITELLM_CONFIG_PATH, MAX_FIXED_INPUT_BYTES, "LiteLLM config").toString("utf8"), { schema: YAML_JSON_SCHEMA });
    const gateway = loadYaml(readBoundedRegularFile(DEFAULT_GATEWAY_CONFIG_PATH, MAX_FIXED_INPUT_BYTES, "gateway config").toString("utf8"), { schema: YAML_JSON_SCHEMA });
    if (!litellm || typeof litellm !== "object" || Array.isArray(litellm)
      || !gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
      throw new Error("managed routing YAML roots must be mappings");
    }
    const routerSettings = (litellm as Record<string, unknown>).router_settings;
    const fallbacks = routerSettings && typeof routerSettings === "object" && !Array.isArray(routerSettings)
      ? (routerSettings as Record<string, unknown>).fallbacks
      : undefined;
    if (!Array.isArray(fallbacks)) throw new Error("LiteLLM router_settings.fallbacks must be a sequence");
    const litellmChains = new Map<string, string[]>();
    for (const raw of fallbacks) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1) {
        throw new Error("every LiteLLM fallback entry must be a one-route mapping");
      }
      const [logicalName, chain] = Object.entries(raw as Record<string, unknown>)[0]!;
      if (!isExactRouteName(logicalName)) throw new Error("LiteLLM fallback route name is invalid");
      if (litellmChains.has(logicalName)) throw new Error(`duplicate LiteLLM fallback route ${logicalName}`);
      litellmChains.set(logicalName, stringArray(chain, `router_settings.fallbacks.${logicalName}`));
    }
    const gatewayModels = (gateway as Record<string, unknown>).models;
    if (!gatewayModels || typeof gatewayModels !== "object" || Array.isArray(gatewayModels)) {
      throw new Error("gateway models must be a mapping");
    }
    const gatewayChains = new Map<string, string[]>();
    for (const [logicalName, raw] of Object.entries(gatewayModels as Record<string, unknown>)) {
      if (!isExactRouteName(logicalName) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("gateway model entry is malformed");
      }
      const chain = (raw as Record<string, unknown>).fallback_chain;
      if (chain !== undefined) gatewayChains.set(logicalName, stringArray(chain, `models.${logicalName}.fallback_chain`));
    }
    const chains: Record<string, string[]> = {};
    for (const logicalName of ["editorial-heavy", "editorial-fast", "editorial-cloud-heavy", "editorial-cloud-fast", "github-gpt41"]) {
      const chain = litellmChains.get(logicalName);
      if (!chain) throw new Error(`managed LiteLLM chain ${logicalName} is missing or malformed`);
      chains[`litellm:${logicalName}`] = chain;
    }
    for (const logicalName of ["editorial-heavy", "editorial-fast"]) {
      const chain = gatewayChains.get(logicalName);
      if (!chain) throw new Error(`managed gateway chain ${logicalName} is missing or malformed`);
      chains[`gateway:${logicalName}`] = chain;
    }
    return { available: true, chains };
  } catch (error) {
    return { available: false, chains: {}, error: sanitizeError(error) };
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0
    || entry !== entry.trim() || /[\x00-\x1f\x7f]/.test(entry)) || new Set(value).size !== value.length) {
    throw new Error(`${field} must be an array of unique exact nonempty strings`);
  }
  return [...value];
}

function isExactRouteName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

function expectedProbeCategory(code: number): "routable" | "dead" | "timeout" | "other" {
  if ([200, 429, 500, 503].includes(code)) return "routable";
  if ([400, 401, 402, 403, 404, 410].includes(code)) return "dead";
  if (code === 0 || code === 408) return "timeout";
  return "other";
}

interface ParsedReprobe {
  ts: number;
  changed: boolean;
  pool: string[];
  live: string[];
  limited: string[];
  dead: string[];
  hang: string[];
  timeout: string[];
  history: Record<string, R1HistoryEntry>;
  malformedHistoryModels: string[];
  ledgerDecision: {
    policyVersion: number;
    mode: string;
    enforced: boolean;
    asOf: string;
    wouldPrune: string[];
    wouldQuarantine: string[];
  } | null;
}

export function parseReprobeState(value: unknown): ParsedReprobe {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reprobe state must be an object");
  const state = value as Record<string, unknown>;
  if (typeof state.ts !== "number" || !Number.isInteger(state.ts) || state.ts <= 0) throw new Error("reprobe state ts is invalid");
  if (typeof state.changed !== "boolean") throw new Error("reprobe state changed is invalid");
  if (!state.history || typeof state.history !== "object" || Array.isArray(state.history)) throw new Error("reprobe state history is invalid");
  const history: Record<string, R1HistoryEntry> = {};
  const malformedHistoryModels: string[] = [];
  for (const [logicalName, raw] of Object.entries(state.history as Record<string, unknown>)) {
    if (!isExactRouteName(logicalName)) throw new Error("reprobe history contains an invalid logical name");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { malformedHistoryModels.push(logicalName); continue; }
    const entry = raw as Record<string, unknown>;
    const code = entry.code;
    const latency = entry.ms;
    if (typeof code !== "number" || !Number.isInteger(code) || code < 0 || code > 599
      || entry.category !== expectedProbeCategory(code)
      || typeof entry.streak !== "number" || !Number.isInteger(entry.streak) || entry.streak < 1
      || typeof entry.since !== "number" || !Number.isInteger(entry.since) || entry.since <= 0
      || normalizeObservationTs(entry.since) > normalizeObservationTs(state.ts as number)
      || !((latency === null) || (typeof latency === "number" && Number.isInteger(latency) && latency >= 0))) {
      malformedHistoryModels.push(logicalName);
      continue;
    }
    history[logicalName] = {
      code,
      category: expectedProbeCategory(code),
      streak: entry.streak,
      since: entry.since,
      latency: latency as number | null,
    };
  }
  let ledgerDecision: ParsedReprobe["ledgerDecision"] = null;
  if (state.ledger_decisions !== undefined) {
    const raw = state.ledger_decisions;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("reprobe ledger_decisions is invalid");
    const decision = raw as Record<string, unknown>;
    if (!Number.isInteger(decision.policy_version) || decision.policy_version !== 1
      || !isExactRouteName(decision.mode) || decision.mode.length > 64 || typeof decision.enforced !== "boolean"
      || typeof decision.as_of !== "string" || !Number.isFinite(Date.parse(decision.as_of))) {
      throw new Error("reprobe ledger_decisions metadata is invalid");
    }
    ledgerDecision = {
      policyVersion: decision.policy_version as number,
      mode: decision.mode,
      enforced: decision.enforced,
      asOf: decision.as_of,
      wouldPrune: stringArray(decision.would_prune, "ledger_decisions.would_prune"),
      wouldQuarantine: stringArray(decision.would_quarantine, "ledger_decisions.would_quarantine"),
    };
  }
  const pool = stringArray(state.pool, "pool");
  const live = stringArray(state.live, "live");
  const limited = stringArray(state.limited, "limited");
  const dead = stringArray(state.dead, "dead");
  const hang = stringArray(state.hang, "hang");
  const timeout = stringArray(state.timeout, "timeout");
  const stateNames = [...live, ...limited, ...dead, ...hang, ...timeout];
  if (new Set(stateNames).size !== stateNames.length) throw new Error("reprobe state distributions overlap");
  const historyNames = new Set(Object.keys(state.history as Record<string, unknown>));
  if (stateNames.some((logicalName) => !historyNames.has(logicalName))) throw new Error("reprobe state member lacks history");
  const malformed = new Set(malformedHistoryModels);
  const buckets = [
    ["live", live, (code: number) => code === 200],
    ["limited", limited, (code: number) => code === 429],
    ["dead", dead, (code: number) => [400, 401, 402, 403, 404, 410].includes(code)],
    ["hang", hang, (code: number) => code === 0],
    ["timeout", timeout, (code: number) => code === 408],
  ] as const;
  for (const [bucket, members, accepts] of buckets) {
    for (const logicalName of members) {
      const entry = history[logicalName];
      if (entry && !accepts(entry.code ?? -1)) throw new Error(`reprobe ${bucket} member does not match history code`);
    }
  }
  for (const [logicalName, entry] of Object.entries(history)) {
    const expected = entry.code === 200 ? live
      : entry.code === 429 ? limited
        : [400, 401, 402, 403, 404, 410].includes(entry.code ?? -1) ? dead
          : entry.code === 0 ? hang
            : entry.code === 408 ? timeout
              : null;
    if (expected && !expected.includes(logicalName)) throw new Error("reprobe history code is missing from its exact state bucket");
  }
  for (const logicalName of pool) {
    const entry = history[logicalName];
    if (!entry) {
      if (!malformed.has(logicalName)) throw new Error("reprobe pool member lacks history");
      continue;
    }
    if (entry.category !== "routable" && !((entry.code === 0 || entry.code === 408) && entry.streak < 3)) {
      throw new Error("reprobe pool member is neither routable nor a held timeout");
    }
  }
  return {
    ts: state.ts,
    changed: state.changed,
    pool,
    live,
    limited,
    dead,
    hang,
    timeout,
    history,
    malformedHistoryModels: malformedHistoryModels.sort(),
    ledgerDecision,
  };
}

export function collectR2LiveMode(path: string, now: number): R2LiveModeEvidence {
  try {
    const value = readJson(path);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("reprobe state must be an object");
    }
    const raw = (value as Record<string, unknown>).ledger_decisions;
    if (raw === undefined) return { status: "missing" };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("reprobe ledger_decisions is invalid");
    }
    const decision = raw as Record<string, unknown>;
    const asOf = typeof decision.as_of === "string" ? Date.parse(decision.as_of) : Number.NaN;
    if (decision.policy_version !== 1 || !isExactRouteName(decision.mode) || decision.mode.length > 64
      || typeof decision.enforced !== "boolean" || !Number.isInteger(asOf) || asOf <= 0) {
      throw new Error("reprobe ledger_decisions metadata is invalid");
    }
    return {
      status: "verified",
      policyVersion: 1,
      mode: decision.mode,
      enforced: decision.enforced,
      asOf,
    };
  } catch (error) {
    return { status: "unavailable", error: sanitizeError(error) };
  }
}

function parseProperties(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function journalRows(unit: string, since: number, until: number): { available: boolean; rows: Array<Record<string, unknown>>; error?: string } {
  const command = fixedCommand([
    "journalctl",
    "--unit", unit,
    "--since", new Date(since).toISOString(),
    "--until", new Date(until).toISOString(),
    "--output=json",
    "--no-pager",
  ]);
  if (!command.ok) return { available: false, rows: [], error: command.error };
  const rows: Array<Record<string, unknown>> = [];
  for (const line of command.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = safeJsonParse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Record<string, unknown>);
    } catch {
      return { available: false, rows: [], error: "journal emitted malformed JSON" };
    }
  }
  return { available: true, rows };
}

function systemdProperties(unit: string, properties: string[]): { ok: boolean; values: Record<string, string>; error?: string } {
  const command = fixedCommand(["systemctl", "show", unit, `--property=${properties.join(",")}`, "--no-pager"]);
  return command.ok ? { ok: true, values: parseProperties(command.stdout) } : { ok: false, values: {}, error: command.error };
}

function timestampFromSystemd(value: string | undefined): number | null {
  if (!value || value === "n/a") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function journalTimestampMs(row: Record<string, unknown>): number | null {
  const raw = row.__REALTIME_TIMESTAMP;
  const micros = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(micros) && micros > 0 ? Math.floor(micros / 1_000) : null;
}

function serviceJobStarts(rows: Array<Record<string, unknown>>): Array<{ jobId: string; at: number; row: Record<string, unknown> }> {
  const starts: Array<{ jobId: string; at: number; row: Record<string, unknown> }> = [];
  for (const row of rows) {
    const message = typeof row.MESSAGE === "string" ? row.MESSAGE : "";
    const jobId = typeof row.JOB_ID === "string" ? row.JOB_ID : typeof row.JOB_ID === "number" ? String(row.JOB_ID) : "";
    const at = journalTimestampMs(row);
    if (jobId && at !== null && /^Starting model-fallback-reprobe\.service\b/.test(message)) starts.push({ jobId, at, row });
  }
  return starts;
}

function normalizeObservationTs(value: number): number {
  return value > 0 && value < 100_000_000_000 ? value * 1_000 : value;
}

interface PriorEvidenceCollection {
  available: boolean;
  artifacts: number;
  r1: R1Observation[];
  r2: R2ShadowObservation[];
  r1Failures: R1FailureObservation[];
  workFailures: {
    editorial: Array<{ evidenceRef: string; at: number; reason: string }>;
    builder: Array<{ evidenceRef: string; at: number; reason: string }>;
  };
  error?: string;
}

function timestampFromEvidenceName(name: string): number | null {
  const match = name.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json$/);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sameSourceCommits(value: unknown, expected: Record<string, string | null>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  return exactObjectKeys(actual, Object.keys(expected))
    && Object.entries(expected).every(([key, commit]) => typeof commit === "string" && actual[key] === commit);
}

function belongsToCandidate(value: unknown, expected: Record<string, string | null>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  return Object.entries(expected).every(([key, commit]) => typeof commit === "string" && actual[key] === commit);
}

function knownObservationStageLink(path: string, stat: ReturnType<typeof lstatSync>): boolean {
  if (stat.nlink !== 2) return false;
  const stagePattern = /^\.observation\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
  let matches = 0;
  for (const name of readdirSync(dirname(path))) {
    if (!stagePattern.test(name)) continue;
    const stagePath = join(dirname(path), name);
    const stage = lstatSync(stagePath);
    if (!stage.isFile() || stage.isSymbolicLink() || stage.uid !== 0 || stage.nlink !== 2
      || stage.dev !== stat.dev || stage.ino !== stat.ino || stage.size !== stat.size) continue;
    matches += 1;
  }
  // nlink=2 means the immutable timestamp plus this one known publication
  // stage account for every name of the inode; any other shape remains fatal.
  return matches === 1;
}

function trustedTimestampedEvidenceStat(path: string): ReturnType<typeof lstatSync> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.size <= 0 || stat.size > MAX_EVIDENCE_ARTIFACT_BYTES
    || (stat.mode & 0o222) !== 0 || (stat.nlink !== 1 && !knownObservationStageLink(path, stat))) {
    throw new Error("artifact is not an immutable root-owned bounded regular file");
  }
  return stat;
}

function validSourceClean(value: unknown): value is EvidenceEnvelope["sourceClean"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sourceClean = value as Record<string, unknown>;
  return exactObjectKeys(sourceClean, ["controlSurface", "mimounReprobe"])
    && typeof sourceClean.controlSurface === "boolean" && typeof sourceClean.mimounReprobe === "boolean";
}

function validFullSourceCommits(value: unknown): value is Record<"controlSurface" | "mimoun", string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const commits = value as Record<string, unknown>;
  return exactObjectKeys(commits, ["controlSurface", "mimoun"])
    && typeof commits.controlSurface === "string" && /^[a-f0-9]{40}$/i.test(commits.controlSurface)
    && typeof commits.mimoun === "string" && /^[a-f0-9]{40}$/i.test(commits.mimoun);
}

function validQueryWindows(value: unknown, generatedAt: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const windows = value as Record<string, unknown>;
  if (!exactObjectKeys(windows, ["r0", "r2Recent", "r1Restarts"])) return false;
  const exact = (name: string, from: number, to: number): boolean => {
    const raw = windows[name];
    return Boolean(raw && typeof raw === "object" && !Array.isArray(raw)
      && exactObjectKeys(raw as Record<string, unknown>, ["from", "to"])
      && (raw as Record<string, unknown>).from === from && (raw as Record<string, unknown>).to === to);
  };
  return exact("r0", R0_CUTOFF_MS, generatedAt)
    && exact("r2Recent", generatedAt - R2_RECENT_WINDOW_MS, generatedAt)
    && exact("r1Restarts", generatedAt - 24 * 60 * 60 * 1_000, generatedAt);
}

function validEnvelopeFrame(
  value: unknown,
  fileTimestamp: number,
  ceiling: number,
  sourceCommits: Record<string, string | null>,
): value is EvidenceEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const parsed = value as Record<string, unknown>;
  if (!exactObjectKeys(parsed, [
    "schemaVersion", "generatedAt", "generatedAtUtc", "sourceCommits", "sourceClean",
    "cutoffs", "queryWindows", "observations", "report",
  ])) return false;
  if (parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.generatedAt !== "number"
    || !Number.isInteger(parsed.generatedAt) || parsed.generatedAt < R0_CUTOFF_MS || parsed.generatedAt > ceiling
    || fileTimestamp > ceiling || Math.floor(parsed.generatedAt / 1_000) * 1_000 !== fileTimestamp
    || parsed.generatedAtUtc !== new Date(parsed.generatedAt).toISOString()
    || !sameSourceCommits(parsed.sourceCommits, sourceCommits) || !validSourceClean(parsed.sourceClean)) return false;
  const cutoffs = parsed.cutoffs;
  if (!cutoffs || typeof cutoffs !== "object" || Array.isArray(cutoffs)
    || !exactObjectKeys(cutoffs as Record<string, unknown>, ["r0Unified"])
    || (cutoffs as Record<string, unknown>).r0Unified !== R0_CUTOFF_MS
    || !validQueryWindows(parsed.queryWindows, parsed.generatedAt)) return false;
  const observations = parsed.observations;
  if (!observations || typeof observations !== "object" || Array.isArray(observations)
    || !exactObjectKeys(observations as Record<string, unknown>, ["r1Current", "r2Current", "r1Failures"])
    || !Array.isArray((observations as Record<string, unknown>).r1Failures)) return false;
  const observationRecord = observations as Record<string, unknown>;
  const r1 = observationRecord.r1Current;
  const r2 = observationRecord.r2Current;
  if (r1 !== null && !validR1Observation(r1, parsed.generatedAt)) return false;
  if (r2 !== null && (r1 === null || !validR2Observation(r2, r1 as R1Observation, parsed.generatedAt))) return false;
  return validStoredReport(parsed.report, parsed.generatedAt);
}

function validR1Observation(value: unknown, ceiling: number): value is R1Observation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const timerTriggeredAt = typeof row.timerTriggeredAt === "number" && Number.isFinite(row.timerTriggeredAt)
    && row.timerTriggeredAt >= 0 && row.timerTriggeredAt <= 8_640_000_000_000_000
    ? row.timerTriggeredAt
    : null;
  const isoOpportunityId = timerTriggeredAt === null
    ? null
    : `model-fallback-reprobe.timer@${new Date(timerTriggeredAt).toISOString()}`;
  const arrays = ["pool", "live", "limited", "dead", "hang", "timeout"];
  if (!arrays.every((key) => Array.isArray(row[key])
    && (row[key] as unknown[]).every((entry) => typeof entry === "string" && entry.length > 0 && entry === entry.trim() && !/[\x00-\x1f\x7f]/.test(entry))
    && new Set(row[key] as unknown[]).size === (row[key] as unknown[]).length)) return false;
  if (row.priorPool !== undefined && (!Array.isArray(row.priorPool)
    || row.priorPool.some((entry) => !isExactRouteName(entry))
    || new Set(row.priorPool).size !== row.priorPool.length)) return false;
  if (row.priorPool !== undefined && row.priorPoolSource !== "prior-observation" && row.priorPoolSource !== "unchanged-render") return false;
  if (typeof row.stateTs !== "number" || !Number.isFinite(row.stateTs) || row.stateTs <= 0
    || typeof row.changed !== "boolean" || typeof row.scheduled !== "boolean"
    || typeof row.invocationResult !== "string" || !/^[a-f0-9]{32}$/i.test(String(row.invocationId ?? ""))
    || typeof row.invocationStartedAt !== "number" || !Number.isFinite(row.invocationStartedAt)
    || typeof row.invocationFinishedAt !== "number" || !Number.isFinite(row.invocationFinishedAt)
    || timerTriggeredAt === null
    || (row.timerTriggerId !== `model-fallback-reprobe.timer@${row.timerTriggeredAt}`
      && row.timerTriggerId !== isoOpportunityId)
    || typeof row.serviceJobId !== "string" || !/^\d+$/.test(row.serviceJobId)
    || Math.abs((row.invocationStartedAt as number) - (row.timerTriggeredAt as number)) > 2 * 60 * 1_000
    || row.invocationFinishedAt < row.invocationStartedAt
    || normalizeObservationTs(row.stateTs as number) + 999 < (row.invocationStartedAt as number)
    || normalizeObservationTs(row.stateTs as number) > (row.invocationFinishedAt as number)
    || normalizeObservationTs(row.stateTs as number) > ceiling
    || (row.invocationStartedAt as number) > ceiling || (row.invocationFinishedAt as number) > ceiling
    || (row.timerTriggeredAt as number) > ceiling
    || !Number.isInteger(row.restartCount24h) || (row.restartCount24h as number) < 0) return false;
  if (row.malformedHistoryModels !== undefined && (!Array.isArray(row.malformedHistoryModels)
    || row.malformedHistoryModels.some((entry) => !isExactRouteName(entry))
    || new Set(row.malformedHistoryModels).size !== row.malformedHistoryModels.length)) return false;
  if (!row.history || typeof row.history !== "object" || Array.isArray(row.history)) return false;
  for (const [logicalName, history] of Object.entries(row.history as Record<string, unknown>)) {
    if (!isExactRouteName(logicalName)) return false;
    if (!history || typeof history !== "object" || Array.isArray(history)) return false;
    const entry = history as Record<string, unknown>;
    if (typeof entry.code !== "number" || !Number.isInteger(entry.code) || entry.code < 0 || entry.code > 599
      || entry.category !== expectedProbeCategory(entry.code)
      || !Number.isInteger(entry.streak) || (entry.streak as number) < 1
      || typeof entry.since !== "number" || !Number.isInteger(entry.since) || entry.since <= 0
      || normalizeObservationTs(entry.since) > normalizeObservationTs(row.stateTs as number)
      || normalizeObservationTs(entry.since) > ceiling
      || !(entry.latency === null || (typeof entry.latency === "number" && Number.isInteger(entry.latency) && entry.latency >= 0))) return false;
  }
  const live = row.live as string[];
  const limited = row.limited as string[];
  const dead = row.dead as string[];
  const hang = row.hang as string[];
  const timeout = row.timeout as string[];
  const states = [...live, ...limited, ...dead, ...hang, ...timeout];
  if (new Set(states).size !== states.length) return false;
  const malformed = new Set((row.malformedHistoryModels as string[] | undefined) ?? []);
  if (states.some((logicalName) => !Object.hasOwn(row.history as object, logicalName) && !malformed.has(logicalName))) return false;
  const history = row.history as Record<string, R1HistoryEntry>;
  const buckets = [
    [live, (code: number) => code === 200],
    [limited, (code: number) => code === 429],
    [dead, (code: number) => [400, 401, 402, 403, 404, 410].includes(code)],
    [hang, (code: number) => code === 0],
    [timeout, (code: number) => code === 408],
  ] as const;
  for (const [members, accepts] of buckets) {
    if (members.some((logicalName) => history[logicalName] && !accepts(history[logicalName]!.code ?? -1))) return false;
  }
  for (const [logicalName, entry] of Object.entries(history)) {
    const expected = entry.code === 200 ? live
      : entry.code === 429 ? limited
        : [400, 401, 402, 403, 404, 410].includes(entry.code ?? -1) ? dead
          : entry.code === 0 ? hang
            : entry.code === 408 ? timeout
              : null;
    if (expected && !expected.includes(logicalName)) return false;
  }
  const priorPool = new Set(row.priorPool as string[] | undefined);
  for (const logicalName of row.pool as string[]) {
    const entry = history[logicalName];
    if (!entry) {
      if (!malformed.has(logicalName)) return false;
      continue;
    }
    const heldTimeout = (entry.code === 0 || entry.code === 408) && entry.streak < 3 && priorPool.has(logicalName);
    if (entry.category !== "routable" && !heldTimeout) return false;
  }
  return true;
}

function validR2Observation(value: unknown, paired: R1Observation, ceiling: number): value is R2ShadowObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.invocationId === paired.invocationId && row.stateTs === paired.stateTs
    && typeof row.decisionAt === "number" && Number.isFinite(row.decisionAt) && row.decisionAt > 0
    && normalizeObservationTs(row.decisionAt as number) <= ceiling
    && row.policyVersion === 1 && row.ledgerAvailable === true && row.enforced === false
    && row.scheduled === paired.scheduled && row.success === (paired.invocationResult === "success")
    && Array.isArray(row.wouldPrune) && row.wouldPrune.every((entry) => typeof entry === "string" && entry.length > 0)
    && Array.isArray(row.wouldQuarantine) && row.wouldQuarantine.every((entry) => typeof entry === "string" && entry.length > 0)
    && (row.litellmChanged === false || row.litellmChanged === true || row.litellmChanged === null)
    && (row.gatewayChanged === false || row.gatewayChanged === true || row.gatewayChanged === null)
    && typeof row.litellmAfterHash === "string" && /^[a-f0-9]{64}$/i.test(row.litellmAfterHash)
    && typeof row.gatewayAfterHash === "string" && /^[a-f0-9]{64}$/i.test(row.gatewayAfterHash);
}

function validStoredReport(value: unknown, generatedAt: number): value is RepairArcReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!exactObjectKeys(value as Record<string, unknown>, ["generatedAt", "overall", "checks"])) return false;
  const report = value as Partial<RepairArcReport>;
  if (report.generatedAt !== generatedAt || !Array.isArray(report.checks)) return false;
  const checks = report.checks as unknown[];
  const ids = new Set<string>();
  for (const raw of checks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    if (!exactObjectKeys(raw as Record<string, unknown>, ["id", "verdict", "note", "metrics", "evidence"])) return false;
    const check = raw as Partial<CheckResult>;
    if (typeof check.id !== "string" || ids.has(check.id)
      || !["PASS", "PENDING", "UNVERIFIABLE", "FAIL"].includes(String(check.verdict))
      || typeof check.note !== "string" || !check.metrics || typeof check.metrics !== "object" || Array.isArray(check.metrics)
      || Object.values(check.metrics).some((metric) => metric !== null && !["string", "number", "boolean"].includes(typeof metric))
      || !Array.isArray(check.evidence) || check.evidence.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) return false;
    ids.add(check.id);
  }
  if (ids.size !== REQUIRED_CHECK_IDS.size || [...REQUIRED_CHECK_IDS].some((id) => !ids.has(id))) return false;
  return report.overall === overallFromChecks(report.checks as CheckResult[]);
}

export function loadPriorEvidence(
  evidenceDir: string,
  now: number,
  sourceCommits: Record<string, string | null>,
): PriorEvidenceCollection {
  const empty = (): PriorEvidenceCollection => ({
    available: true,
    artifacts: 0,
    r1: [],
    r2: [],
    r1Failures: [],
    workFailures: { editorial: [], builder: [] },
  });
  const collection = empty();
  let files: string[];
  try { files = readdirSync(evidenceDir).filter((name) => /^\d{8}T\d{6}Z\.json$/.test(name)).sort(); }
  catch (error) { return { ...collection, available: false, error: sanitizeError(error) }; }
  if (files.length > MAX_GLOBAL_EVIDENCE_ARTIFACTS) {
    return { ...collection, available: false, error: `more than ${MAX_GLOBAL_EVIDENCE_ARTIFACTS} global timestamped evidence artifacts require operator archival` };
  }
  let candidateArtifacts = 0;
  for (const name of files) {
    const fileTimestamp = timestampFromEvidenceName(name);
    if (fileTimestamp === null) continue;
    const path = join(evidenceDir, name);
    try {
      trustedTimestampedEvidenceStat(path);
      const parsed = readJson(path) as Partial<EvidenceEnvelope>;
      if (parsed.schemaVersion !== SCHEMA_VERSION) continue;
      // A different candidate starts a separate series and does not consume
      // this candidate's 128-artifact retention budget.
      if (!belongsToCandidate(parsed.sourceCommits, sourceCommits)) continue;
      candidateArtifacts += 1;
      if (candidateArtifacts > MAX_CANDIDATE_EVIDENCE_ARTIFACTS) {
        throw new Error(`more than ${MAX_CANDIDATE_EVIDENCE_ARTIFACTS} candidate evidence artifacts require operator archival`);
      }
      if (!validEnvelopeFrame(parsed, fileTimestamp, now, sourceCommits)) throw new Error("artifact provenance is invalid");
      collection.artifacts += 1;
      // A verifier run from a dirty routing-relevant source tree is still a
      // truthful immutable event and remains countable. It cannot, however,
      // supply reusable R1/R2 samples or sticky run/failure evidence.
      const reusableSource = parsed.sourceClean.controlSurface && parsed.sourceClean.mimounReprobe;
      // Historical envelopes contain copied journal outcomes, not causal
      // unit-boundary receipts. Retain the envelopes as truthful events but do
      // not reuse their R1 success/failure assertions for strict acceptance.
      if (reusableSource) {
        for (const kind of ["editorial", "builder"] as const) {
          const failed = parsed.report.checks.find((check) => check.id === `r6.${kind}` && check.verdict === "FAIL");
          if (failed) collection.workFailures[kind].push({ evidenceRef: path, at: parsed.generatedAt, reason: failed.note });
        }
      }
      if (parsed.generatedAt < Math.max(R1_ACCEPTANCE_START_MS, now - 24 * 60 * 60 * 1_000)) continue;
      const r1 = parsed.observations.r1Current;
      const r2 = parsed.observations.r2Current;
      if (r1 === null && r2 === null) continue;
      if (!validR1Observation(r1, parsed.generatedAt)) throw new Error("R1 observation shape is invalid");
      if (r2 !== null && !validR2Observation(r2, r1, parsed.generatedAt)) throw new Error("R2 observation shape/provenance is invalid");
      if (!reusableSource) continue;
      // The future scheduled wrapper/receipt reader is deliberately not
      // implemented in this slice. Journal proximity and a stored
      // `scheduled:true` flag cannot become reusable evidence.
    } catch (error) {
      return { ...collection, available: false, error: `${name}: ${sanitizeError(error)}` };
    }
  }
  return collection;
}

function collectR1(
  now: number,
  reprobePath: string,
  prior: R1Observation[],
  priorR2: R2ShadowObservation[],
  priorFailures: R1FailureObservation[],
): {
  input: R1Input;
  current: R1Observation | null;
  r2Current: R2ShadowObservation | null;
  failures: R1FailureObservation[];
} {
  const receiptCoverage = {
    status: "unavailable" as const,
    settledOpportunities: 0,
    coveredOpportunities: 0,
  };
  // Until the separately reviewed timer-only wrapper exists, historical
  // journal observations are diagnostic only and cannot supply reusable
  // success or failure receipts.
  prior = [];
  priorR2 = [];
  priorFailures = [];
  const serviceJournal = journalRows("model-fallback-reprobe.service", R1_ACCEPTANCE_START_MS, now);
  const startsJournal = journalRows("litellm.service", now - 24 * 60 * 60 * 1_000, now);
  if (!serviceJournal.available || !startsJournal.available) {
    return {
      input: { journalAvailable: false, observations: [], failures: [], receiptCoverage, acceptanceStartAt: R1_ACCEPTANCE_START_MS, error: serviceJournal.error ?? startsJournal.error ?? "journal unavailable" },
      current: null,
      r2Current: null,
      failures: [],
    };
  }
  const failures: R1FailureObservation[] = [];
  let state: ParsedReprobe;
  try { state = parseReprobeState(readJson(reprobePath)); }
  catch (error) {
    return { input: { journalAvailable: false, observations: [], failures, receiptCoverage, acceptanceStartAt: R1_ACCEPTANCE_START_MS, error: sanitizeError(error) }, current: null, r2Current: null, failures };
  }
  const service = systemdProperties("model-fallback-reprobe.service", ["InvocationID", "Result", "ExecMainStartTimestamp", "ExecMainExitTimestamp"]);
  const timer = systemdProperties("model-fallback-reprobe.timer", ["LastTriggerUSec"]);
  if (!service.ok || !timer.ok) {
    return { input: { journalAvailable: false, observations: [], failures, receiptCoverage, acceptanceStartAt: R1_ACCEPTANCE_START_MS, error: service.error ?? timer.error }, current: null, r2Current: null, failures };
  }
  const startedAt = timestampFromSystemd(service.values.ExecMainStartTimestamp);
  const finishedAt = timestampFromSystemd(service.values.ExecMainExitTimestamp);
  const lastTrigger = timestampFromSystemd(timer.values.LastTriggerUSec);
  // Proximity is retained only as a diagnostic field. It is not causal timer
  // provenance, so this verifier never turns it into `scheduled:true`.
  const scheduled = false;
  const restartCount24h = startsJournal.rows.filter((row) => {
    const message = typeof row.MESSAGE === "string" ? row.MESSAGE : "";
    return /^Started litellm\.service\b/.test(message) || /^Started LiteLLM\b/i.test(message);
  }).length;
  const stateTsMs = state.ts < 100_000_000_000 ? state.ts * 1_000 : state.ts;
  const propertyInvocation = service.values.InvocationID ?? "";
  const invocationJournalRows = serviceJournal.rows.filter((row) => row._SYSTEMD_INVOCATION_ID === propertyInvocation);
  const invocationResult = service.values.Result || "unknown";
  const matchingStarts = startedAt === null ? [] : serviceJobStarts(serviceJournal.rows).filter((entry) => Math.abs(entry.at - startedAt) <= 2_000);
  const currentJob = matchingStarts.length === 1 ? matchingStarts[0]! : null;
  const terminalJob = currentJob ? serviceJournal.rows.find((row) => {
    const jobId = typeof row.JOB_ID === "string" ? row.JOB_ID : typeof row.JOB_ID === "number" ? String(row.JOB_ID) : "";
    const message = typeof row.MESSAGE === "string" ? row.MESSAGE : "";
    return jobId === currentJob.jobId && (/^Finished model-fallback-reprobe\.service\b/.test(message)
      || /^Failed (?:to start )?model-fallback-reprobe\.service\b/.test(message));
  }) : null;
  const hasTerminalRecord = Boolean(terminalJob && terminalJob.JOB_RESULT === "done");
  if (!propertyInvocation || invocationJournalRows.length === 0 || startedAt === null || finishedAt === null || lastTrigger === null
    || finishedAt < startedAt || !currentJob || stateTsMs > now || startedAt > now || finishedAt > now || (lastTrigger !== null && lastTrigger > now)
    || (invocationResult === "success" && !hasTerminalRecord)) {
    return {
      input: { journalAvailable: true, observations: [], failures, receiptCoverage, rollingRestartCount24h: restartCount24h, acceptanceStartAt: R1_ACCEPTANCE_START_MS },
      current: null,
      r2Current: null,
      failures,
    };
  }
  const invocationId = propertyInvocation;
  if (invocationResult === "success" && (stateTsMs + 999 < startedAt || stateTsMs > finishedAt)) {
    return {
      input: { journalAvailable: true, observations: [], failures, receiptCoverage, rollingRestartCount24h: restartCount24h, acceptanceStartAt: R1_ACCEPTANCE_START_MS },
      current: null,
      r2Current: null,
      failures,
    };
  }
  const priorPool = [...prior]
    .filter((entry) => entry.invocationId !== invocationId && normalizeObservationTs(entry.stateTs) < stateTsMs)
    .sort((a, b) => normalizeObservationTs(a.stateTs) - normalizeObservationTs(b.stateTs))
    .at(-1)?.pool;
  const routingMessage = serviceJournal.rows
    .filter((row) => row._SYSTEMD_INVOCATION_ID === invocationId)
    .map((row) => typeof row.MESSAGE === "string" ? row.MESSAGE : "")
    .find((message) => /litellm_changed=(?:True|False).*gateway_changed=(?:True|False)/.test(message));
  const routingMatch = routingMessage?.match(/litellm_changed=(True|False).*gateway_changed=(True|False)/);
  const litellmHash = sha256File(DEFAULT_LITELLM_CONFIG_PATH);
  const gatewayHash = sha256File(DEFAULT_GATEWAY_CONFIG_PATH);
  const unchangedRenderProof = !state.changed && routingMatch?.[1] === "False" && routingMatch?.[2] === "False"
    && typeof litellmHash === "string" && typeof gatewayHash === "string";
  const provenPriorPool = priorPool ?? (unchangedRenderProof ? state.pool : undefined);
  const current: R1Observation = {
    stateTs: state.ts,
    changed: state.changed,
    pool: state.pool,
    live: state.live,
    limited: state.limited,
    dead: state.dead,
    hang: state.hang,
    timeout: state.timeout,
    history: state.history,
    malformedHistoryModels: state.malformedHistoryModels,
    ...(provenPriorPool ? {
      priorPool: provenPriorPool,
      priorPoolSource: priorPool ? "prior-observation" as const : "unchanged-render" as const,
    } : {}),
    invocationId,
    invocationResult,
    invocationStartedAt: startedAt,
    invocationFinishedAt: finishedAt,
    timerTriggeredAt: lastTrigger,
    timerTriggerId: `model-fallback-reprobe.timer@${lastTrigger}`,
    serviceJobId: currentJob.jobId,
    scheduled,
    restartCount24h,
  };
  const ledgerAvailable = !invocationJournalRows.some((row) =>
    typeof row.MESSAGE === "string" && /ledger reconciliation unavailable/i.test(row.MESSAGE));
  const r2Current: R2ShadowObservation | null = state.ledgerDecision?.mode === "shadow"
    ? {
      invocationId: current.invocationId,
      stateTs: current.stateTs,
      decisionAt: Date.parse(state.ledgerDecision.asOf),
      policyVersion: state.ledgerDecision.policyVersion,
      ledgerAvailable,
      enforced: state.ledgerDecision.enforced,
      scheduled: current.scheduled,
      success: current.invocationResult === "success",
      wouldPrune: state.ledgerDecision.wouldPrune,
      wouldQuarantine: state.ledgerDecision.wouldQuarantine,
      litellmChanged: routingMatch ? routingMatch[1] === "True" : null,
      gatewayChanged: routingMatch ? routingMatch[2] === "True" : null,
      litellmAfterHash: litellmHash,
      gatewayAfterHash: gatewayHash,
    }
    : null;
  const previousCurrent = prior.find((entry) => entry.invocationId === current.invocationId);
  const previousR2 = priorR2.find((entry) => entry.invocationId === current.invocationId);
  if (previousCurrent) {
    const { restartCount24h: _previousRestartCount, ...previousImmutable } = previousCurrent;
    const { restartCount24h: _currentRestartCount, ...currentImmutable } = current;
    const r1Conflict = JSON.stringify(previousImmutable) !== JSON.stringify(currentImmutable);
    const r2Conflict = previousR2
      ? r2Current === null || JSON.stringify(previousR2) !== JSON.stringify(r2Current)
      : r2Current !== null;
    if (r1Conflict || r2Conflict) {
      return {
        input: {
          journalAvailable: false,
          observations: prior,
          failures,
          receiptCoverage,
          rollingRestartCount24h: restartCount24h,
          acceptanceStartAt: R1_ACCEPTANCE_START_MS,
          error: "current state conflicts with the first immutable capture of this invocation",
        },
        current: null,
        r2Current: null,
        failures,
      };
    }
  }
  const deduped = new Map<string, R1Observation>();
  for (const entry of prior) {
    if (entry.invocationId && !deduped.has(entry.invocationId)) deduped.set(entry.invocationId, entry);
  }
  if (current.invocationId && !deduped.has(current.invocationId)) deduped.set(current.invocationId, current);
  const immutableCurrent = deduped.get(current.invocationId) ?? current;
  return {
    input: {
      journalAvailable: true,
      observations: [...deduped.values()],
      failures,
      receiptCoverage,
      rollingRestartCount24h: restartCount24h,
      acceptanceStartAt: R1_ACCEPTANCE_START_MS,
    },
    current: immutableCurrent,
    r2Current: previousR2 ?? r2Current,
    failures,
  };
}

export function deriveR2Routes(healthModels: unknown, reprobe: R1Observation | null): R2Route[] {
  const routeMap = new Map<string, R2Route>();
  const probedRoster = new Set([
    ...Object.keys(reprobe?.history ?? {}),
    ...(reprobe?.malformedHistoryModels ?? []),
  ]);
  if (Array.isArray(healthModels)) {
    for (const raw of healthModels) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const model = raw as Record<string, unknown>;
      if (typeof model.logicalName !== "string" || !model.logicalName) continue;
      if (routeMap.has(model.logicalName)) throw new Error(`duplicate model-health logical route ${model.logicalName}`);
      routeMap.set(model.logicalName, {
        logicalName: model.logicalName,
        resolvedModel: isExactRouteName(model.resolvedModel) ? model.resolvedModel : null,
        modelId: isExactRouteName(model.modelId) ? model.modelId : null,
        // The state history is rebuilt from the current `to_probe` set on every
        // successful scheduled cycle. Pool membership is an outcome, not the
        // eligibility roster, so already-pruned routes must remain in scope.
        eligible: probedRoster.has(model.logicalName),
        eligibilityKnown: true,
      });
    }
  }
  for (const logicalName of probedRoster) {
    const existing = routeMap.get(logicalName);
    routeMap.set(logicalName, existing
      ? { ...existing, eligible: true, eligibilityKnown: true }
      : { logicalName, eligible: true, eligibilityKnown: true });
  }
  return [...routeMap.values()];
}

function collectRoutes(reprobe: R1Observation | null): R2Route[] {
  try {
    const parsed = readJson(DEFAULT_MODEL_HEALTH_PATH);
    const models = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).models
      : null;
    return deriveR2Routes(models, reprobe);
  } catch {
    // Reprobe history still supplies the exact current eligible roster even if
    // the slower model-health inventory is transiently unreadable.
    return deriveR2Routes([], reprobe);
  }
}

export function readOperatorInput(path: string | undefined): OperatorPayload {
  if (!path) return {};
  let value: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1024 * 1024) {
      throw new CliArgumentError("--operator-input must be a bounded regular non-symlink file");
    }
    value = readJson(path);
  } catch (error) {
    if (error instanceof CliArgumentError) throw error;
    throw new CliArgumentError(`--operator-input could not be read: ${sanitizeError(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliArgumentError("--operator-input must contain a JSON object");
  const allowed = new Set(["r2", "realWork", "r4Disposition", "r5Disposition", "validation", "acceptanceLog"]);
  const unexpected = Object.keys(value as Record<string, unknown>).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new CliArgumentError(`--operator-input contains forbidden fields: ${unexpected.sort().join(", ")}`);
  }
  const operator = value as Record<string, unknown>;
  if (operator.validation !== undefined) {
    if (!operator.validation || typeof operator.validation !== "object" || Array.isArray(operator.validation)) {
      throw new CliArgumentError("--operator-input validation must be an immutable-manifest pointer");
    }
    const pointer = operator.validation as Record<string, unknown>;
    const keys = Object.keys(pointer);
    if (keys.length !== 2 || !keys.includes("manifestPath") || !keys.includes("manifestSha256")
      || typeof pointer.manifestPath !== "string" || typeof pointer.manifestSha256 !== "string") {
      throw new CliArgumentError("--operator-input validation accepts only manifestPath and manifestSha256");
    }
  }
  if (operator.r2 !== undefined) {
    if (!operator.r2 || typeof operator.r2 !== "object" || Array.isArray(operator.r2)) {
      throw new CliArgumentError("--operator-input r2 must be an object");
    }
    const allowedR2 = new Set([
      "policyApproval", "exact429Clocks", "decayWindowMs", "baseline",
    ]);
    const forbiddenR2 = Object.keys(operator.r2 as Record<string, unknown>).filter((key) => !allowedR2.has(key));
    if (forbiddenR2.length > 0) {
      throw new CliArgumentError(`--operator-input r2 contains forbidden fields: ${forbiddenR2.sort().join(", ")}`);
    }
  }
  return value as OperatorPayload;
}

const VALIDATION_COMMANDS = {
  focused: [
    "bun", "test",
    "server/gateway/router.test.ts",
    "server/api/modelHealthState.test.ts",
    "server/api/models.test.ts",
    "server/api/router.test.ts",
    "server/api/repairArcVerify.test.ts",
    "app/routes/modelsHealthView.test.ts",
    "--timeout=60000", "--max-concurrency=4", "--reporter=dots",
  ],
  focusedEnv: { DASHBOARD_DB: "1" },
  typecheck: ["bun", "run", "typecheck"],
  build: ["bun", "run", "build"],
  freshHost: ["e2e/fresh-host/run.sh"],
};

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys) === JSON.stringify([...expected].sort());
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function readImmutableReceipt(
  path: string,
  expectedSha256: string | undefined,
  prefix: "validation" | "r6",
  receiptRoot = join(DEFAULT_EVIDENCE_DIR, "receipts"),
): { value: unknown; sha256: string } {
  const resolved = resolve(path);
  const pattern = prefix === "validation"
    ? /^validation-[a-f0-9]{40}-[a-f0-9-]{36}\.json$/i
    : /^r6-(?:editorial|builder)-[A-Za-z0-9._-]+\.json$/;
  if (dirname(resolved) !== receiptRoot || !pattern.test(basename(resolved))) throw new Error(`${prefix} receipt path is outside the fixed receipt directory`);
  const payload = readImmutableArtifact(resolved, expectedSha256, receiptRoot, pattern, 1024 * 1024, `${prefix} receipt`);
  return { value: safeJsonParse(payload.bytes.toString("utf8")), sha256: payload.sha256 };
}

function readImmutableArtifact(
  path: string,
  expectedSha256: string | undefined,
  receiptRoot: string,
  filenamePattern: RegExp,
  maxBytes: number,
  label: string,
): { bytes: Buffer; sha256: string } {
  const resolvedRoot = resolve(receiptRoot);
  const resolved = resolve(path);
  if (dirname(resolved) !== resolvedRoot || !filenamePattern.test(basename(resolved))) {
    throw new Error(`${label} path is outside the fixed receipt directory`);
  }
  const parent = lstatSync(receiptRoot);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0
    || realpathSync(receiptRoot) !== resolvedRoot || (parent.mode & 0o022) !== 0) {
    throw new Error("receipt directory is not trustworthy");
  }
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error(`${label} SHA-256 is malformed`);
  const fd = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1
      || before.size <= 0 || before.size > maxBytes || (before.mode & 0o222) !== 0) {
      throw new Error(`${label} is not an immutable root-owned bounded regular file`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== before.size) {
      throw new Error(`${label} changed during its stable read`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase()) throw new Error(`${label} SHA-256 does not match`);
    return { bytes, sha256 };
  } finally {
    closeSync(fd);
  }
}

function failedValidation(commit: string | null, candidateClean: boolean, error: unknown): ValidationObservation {
  return {
    recordedAt: 0,
    commit: commit ?? "",
    manifestVerified: false,
    candidateTrackedClean: candidateClean,
    manifestError: sanitizeError(error),
    classifier: { sourceVerified: false, testsPassed: false, cases: 0, evidenceRef: "unavailable" },
    bounded: { focusedTestsPassed: false, testFiles: 0, typecheckPassed: false, buildPassed: false, forbiddenProcessesSpawned: false, evidenceRef: "unavailable" },
    ui: { contractTestsPassed: false, assertions: 0, evidenceRef: "unavailable" },
    freshHost: { apiOnly: false, total: 0, honest: 0, leak: 0, crash: 0, error5xx: 0, commit: commit ?? "", evidenceRef: "unavailable" },
  };
}

export function collectValidationManifest(
  pointer: ValidationManifestPointer | undefined,
  commit: string | null,
  now: number,
  candidateClean: boolean,
  candidateTree: string | null = gitTree("/opt/opencode-control-surface"),
  receiptRoot = join(DEFAULT_EVIDENCE_DIR, "receipts"),
  routerSourcePath = "/opt/opencode-control-surface/server/api/router.ts",
  classifierSourcePath = "/opt/opencode-control-surface/server/gateway/router.ts",
): ValidationObservation | undefined {
  if (!pointer) return undefined;
  try {
    const parsed = readImmutableReceipt(pointer.manifestPath, pointer.manifestSha256, "validation", receiptRoot).value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("validation manifest must be an object");
    const manifest = parsed as Record<string, unknown>;
    if (!exactObjectKeys(manifest, ["schemaVersion", "kind", "runId", "candidateCommit", "candidateTree", "recordedAt", "commands"])) {
      throw new Error("validation manifest has unknown or missing fields");
    }
    if (manifest.schemaVersion !== 2 || manifest.kind !== "spec45-validation" || !isUuidV4(manifest.runId)
      || manifest.candidateCommit !== commit || manifest.candidateTree !== candidateTree
      || typeof commit !== "string" || !/^[a-f0-9]{40}$/i.test(commit)
      || typeof candidateTree !== "string" || !/^[a-f0-9]{40}$/i.test(candidateTree)
      || basename(pointer.manifestPath) !== `validation-${commit}-${manifest.runId}.json`
      || typeof manifest.recordedAt !== "number" || !Number.isInteger(manifest.recordedAt)
      || manifest.recordedAt < R0_CUTOFF_MS || manifest.recordedAt > now) {
      throw new Error("validation manifest provenance is invalid");
    }
    if (!manifest.commands || typeof manifest.commands !== "object" || Array.isArray(manifest.commands)
      || !exactObjectKeys(manifest.commands as Record<string, unknown>, ["focused", "typecheck", "build", "freshHost"])) {
      throw new Error("validation manifest commands are invalid");
    }
    type CommandKey = "focused" | "typecheck" | "build" | "freshHost";
    const expectedArgv: Record<CommandKey, string[]> = {
      focused: VALIDATION_COMMANDS.focused,
      typecheck: VALIDATION_COMMANDS.typecheck,
      build: VALIDATION_COMMANDS.build,
      freshHost: VALIDATION_COMMANDS.freshHost,
    };
    const expectedEnv: Record<CommandKey, Record<string, string>> = {
      focused: VALIDATION_COMMANDS.focusedEnv,
      typecheck: {},
      build: {},
      freshHost: {},
    };
    const commandRecords = manifest.commands as Record<CommandKey, unknown>;
    const commands = {} as Record<CommandKey, Record<string, unknown>>;
    const outputPaths = {} as Record<CommandKey, string>;
    for (const key of ["focused", "typecheck", "build", "freshHost"] as const) {
      const raw = commandRecords[key];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`validation ${key} command is invalid`);
      const record = raw as Record<string, unknown>;
      const expectedKeys = key === "freshHost"
        ? ["startedAt", "finishedAt", "argv", "env", "exitCode", "output", "source", "report"]
        : ["startedAt", "finishedAt", "argv", "env", "exitCode", "output"];
      if (!exactObjectKeys(record, expectedKeys)
        || JSON.stringify(record.argv) !== JSON.stringify(expectedArgv[key])
        || JSON.stringify(record.env) !== JSON.stringify(expectedEnv[key])
        || !Number.isInteger(record.startedAt) || !Number.isInteger(record.finishedAt)
        || (record.startedAt as number) < R0_CUTOFF_MS || (record.finishedAt as number) < (record.startedAt as number)
        || (record.finishedAt as number) - (record.startedAt as number) > 60 * 60 * 1_000
        || (record.finishedAt as number) > manifest.recordedAt || record.exitCode !== 0
        || !record.output || typeof record.output !== "object" || Array.isArray(record.output)
        || !exactObjectKeys(record.output as Record<string, unknown>, ["path", "sha256", "bytes"])) {
        throw new Error(`validation ${key} command provenance is invalid`);
      }
      const output = record.output as Record<string, unknown>;
      const expectedOutputPath = join(receiptRoot, `validation-${commit}-${manifest.runId}-${key}.log`);
      if (output.path !== expectedOutputPath || !isSha256(output.sha256)
        || !Number.isInteger(output.bytes) || (output.bytes as number) <= 0 || (output.bytes as number) > COMMAND_MAX_BUFFER_BYTES) {
        throw new Error(`validation ${key} output reference is invalid`);
      }
      const loaded = readImmutableArtifact(expectedOutputPath, output.sha256, receiptRoot,
        new RegExp(`^validation-${commit}-${manifest.runId}-${key}\\.log$`), COMMAND_MAX_BUFFER_BYTES, `validation ${key} output`);
      if (loaded.bytes.byteLength !== output.bytes) throw new Error(`validation ${key} output byte count does not match`);
      commands[key] = record;
      outputPaths[key] = expectedOutputPath;
    }
    const ordered = [commands.focused, commands.typecheck, commands.build, commands.freshHost];
    if (ordered.some((record, index) => index > 0 && (record.startedAt as number) < (ordered[index - 1]!.finishedAt as number))
      || manifest.recordedAt - (commands.freshHost.finishedAt as number) > 10 * 60 * 1_000) {
      throw new Error("validation command windows overlap or are stale");
    }
    const fresh = commands.freshHost;
    if (!fresh.source || typeof fresh.source !== "object" || Array.isArray(fresh.source)
      || !exactObjectKeys(fresh.source as Record<string, unknown>, ["head", "tree", "detached", "cleanBefore"])
      || (fresh.source as Record<string, unknown>).head !== commit
      || (fresh.source as Record<string, unknown>).tree !== candidateTree
      || (fresh.source as Record<string, unknown>).detached !== true
      || (fresh.source as Record<string, unknown>).cleanBefore !== true
      || !fresh.report || typeof fresh.report !== "object" || Array.isArray(fresh.report)
      || !exactObjectKeys(fresh.report as Record<string, unknown>, ["path", "sha256", "bytes"])) {
      throw new Error("fresh-host detached-source provenance is invalid");
    }
    const reportRef = fresh.report as Record<string, unknown>;
    const expectedReportPath = join(receiptRoot, `fresh-host-${commit}-${manifest.runId}.json`);
    if (reportRef.path !== expectedReportPath || !isSha256(reportRef.sha256)
      || !Number.isInteger(reportRef.bytes) || (reportRef.bytes as number) <= 0 || (reportRef.bytes as number) > 4 * 1024 * 1024) {
      throw new Error("fresh-host report reference is invalid");
    }
    const reportBytes = readImmutableArtifact(expectedReportPath, reportRef.sha256, receiptRoot,
      new RegExp(`^fresh-host-${commit}-${manifest.runId}\\.json$`), 4 * 1024 * 1024, "fresh-host report");
    if (reportBytes.bytes.byteLength !== reportRef.bytes) throw new Error("fresh-host report byte count does not match");
    const reportValue = safeJsonParse(reportBytes.bytes.toString("utf8"));
    if (!reportValue || typeof reportValue !== "object" || Array.isArray(reportValue)) throw new Error("fresh-host report is invalid");
    const report = reportValue as Record<string, unknown>;
    if (!exactObjectKeys(report, ["schemaVersion", "kind", "runId", "candidateCommit", "candidateTree", "generatedAt", "counts", "results"])
      || report.schemaVersion !== 2 || report.kind !== "fresh-host-api-report" || report.runId !== manifest.runId
      || report.candidateCommit !== commit || report.candidateTree !== candidateTree
      || !Number.isInteger(report.generatedAt) || (report.generatedAt as number) < (fresh.startedAt as number)
      || (report.generatedAt as number) > (fresh.finishedAt as number)
      || !report.counts || typeof report.counts !== "object" || Array.isArray(report.counts)
      || !exactObjectKeys(report.counts as Record<string, unknown>, ["HONEST", "LEAK", "CRASH", "ERROR-5xx"])
      || !Array.isArray(report.results) || report.results.length < 1) {
      throw new Error("fresh-host report provenance is invalid");
    }
    const results = report.results as unknown[];
    const allowedVerdicts = new Set(["HONEST", "LEAK", "CRASH", "ERROR-5xx"]);
    const recomputed: Record<string, number> = { HONEST: 0, LEAK: 0, CRASH: 0, "ERROR-5xx": 0 };
    const routes: string[] = [];
    for (const raw of results) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
        || !exactObjectKeys(raw as Record<string, unknown>, ["route", "status", "verdict", "elapsedMs", "detail"])) {
        throw new Error("fresh-host result row is invalid");
      }
      const row = raw as Record<string, unknown>;
      if (typeof row.route !== "string" || !row.route.startsWith("/") || row.route.includes("\0")
        || !Number.isInteger(row.status) || (row.status as number) < 0 || (row.status as number) > 599
        || !allowedVerdicts.has(String(row.verdict)) || !Number.isInteger(row.elapsedMs) || (row.elapsedMs as number) < 0
        || typeof row.detail !== "string" || row.detail.length > 1_000) throw new Error("fresh-host result row shape is invalid");
      routes.push(row.route);
      recomputed[String(row.verdict)]! += 1;
    }
    if (new Set(routes).size !== routes.length) throw new Error("fresh-host report contains duplicate routes");
    const routerSource = readBoundedRegularFile(routerSourcePath, MAX_FIXED_INPUT_BYTES, "candidate API router").toString("utf8");
    const expectedRoutes = new Set<string>(["/"]);
    const routePattern = /method === "GET" && pathname === "([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = routePattern.exec(routerSource))) {
      if (match[1] !== "/api/stream") expectedRoutes.add(match[1]!);
    }
    if (JSON.stringify([...new Set(routes)].sort()) !== JSON.stringify([...expectedRoutes].sort())) {
      throw new Error("fresh-host report route set does not match the candidate router");
    }
    const reportedCounts = report.counts as Record<string, unknown>;
    if (Object.entries(recomputed).some(([key, count]) => reportedCounts[key] !== count)
      || recomputed.HONEST !== results.length || recomputed.LEAK !== 0 || recomputed.CRASH !== 0 || recomputed["ERROR-5xx"] !== 0) {
      throw new Error("fresh-host report counts or verdicts do not pass");
    }
    const classifierSource = readBoundedRegularFile(classifierSourcePath, MAX_FIXED_INPUT_BYTES, "candidate gateway router").toString("utf8");
    const routerSourceVerified = /if \(\/\^litellm 5\\d\\d:\/\.test\(msg\)\) return "server_error";/.test(classifierSource);
    if (!routerSourceVerified) throw new Error("anchored classifier source is not present in the candidate router");
    // Schema v2 records exit codes and output hashes, but it does not bind
    // every command to a detached candidate tree, machine-readable assertion
    // counts, or a before/after process guard. It is fully parsed only so
    // malformed historical receipts receive a precise rejection; it can
    // never become acceptance evidence. Schema v3 is a reviewed future slice.
    throw new Error("validation schema v2 is non-authoritative; candidate-bound schema v3 is not implemented");
  } catch (error) {
    return failedValidation(commit, candidateClean, error);
  }
}

function parseWorkRunReceipt(
  path: string,
  expectedSha256: string | undefined,
  kind: "editorial" | "builder",
  now: number,
): WorkRunObservation {
  const loaded = readImmutableReceipt(path, expectedSha256, "r6");
  const parsed = loaded.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("run receipt must be an object");
  const receipt = parsed as Record<string, unknown>;
  void kind;
  void now;
  void loaded.sha256;
  // Legacy v1 receipts contain self-attested booleans and one flattened hop
  // list. They do not bind a validator artifact, deployment bracket, or
  // authoritative editorial/builder subject record. The v2 producer/reader
  // requires separate operator authorization and is intentionally not
  // implemented by this read-only verifier slice, so no on-disk R6 receipt can
  // currently be marked verified by the CLI.
  throw new Error(`R6 receipt schema ${String(receipt.schemaVersion ?? "unknown")} is not supported by the authoritative v2 reader`);
}

function collectWorkRunReceipts(
  raw: WorkRunObservation | undefined,
  kind: "editorial" | "builder",
  commit: string | null,
  now: number,
): WorkRunObservation | undefined {
  try {
    const receiptRoot = join(DEFAULT_EVIDENCE_DIR, "receipts");
    const names = existsSync(receiptRoot)
      ? readdirSync(receiptRoot).filter((name) => new RegExp(`^r6-${kind}-[A-Za-z0-9._-]+\\.json$`).test(name)).sort()
      : [];
    if (names.length > 32) throw new Error(`more than 32 ${kind} receipts require operator archival`);
    const all = names.map((name) => parseWorkRunReceipt(join(receiptRoot, name), undefined, kind, now));
    const candidate = all.filter((entry) => entry.candidateCommit === commit);
    if (candidate.length === 0) {
      if (!raw) return undefined;
      if (!raw.authorized) return raw;
      throw new Error(`no immutable candidate-bound ${kind} receipt exists`);
    }
    let selected: WorkRunObservation;
    if (isNonEmptyString(raw?.evidenceRef)) {
      selected = candidate.find((entry) => entry.evidenceRef === raw!.evidenceRef)
        ?? (() => { throw new Error(`selected ${kind} receipt is not candidate-bound`); })();
      if (!isNonEmptyString(raw?.receiptSha256) || selected.receiptSha256 !== raw!.receiptSha256.toLowerCase()) {
        throw new Error(`selected ${kind} receipt SHA-256 does not match`);
      }
    } else {
      selected = candidate.at(-1)!;
    }
    const receiptFailures = candidate.filter((entry) => entry.success !== true || entry.validatorPassed !== true || entry.hardDeadRouteUsed !== false)
      .map((entry) => ({
        evidenceRef: entry.evidenceRef!,
        at: entry.finishedAt!,
        reason: `immutable ${kind} receipt records a failed hard gate`,
      }));
    return {
      ...selected,
      attemptCount: candidate.length,
      priorFailures: [...(raw?.priorFailures ?? []), ...receiptFailures],
    };
  } catch (error) {
    if (!raw && !existsSync(join(DEFAULT_EVIDENCE_DIR, "receipts"))) return undefined;
    return {
      authorized: raw?.authorized ?? true,
      ...raw,
      receiptVerified: false,
      receiptError: sanitizeError(error),
    };
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

interface AcceptanceLogRecord {
  recordedAt: number;
  commit: string;
  evidencePath: string;
}

function structuredAcceptanceRecords(log: string): AcceptanceLogRecord[] {
  const records: AcceptanceLogRecord[] = [];
  for (const rawLine of log.split("\n")) {
    const line = rawLine.trim();
    let payload: string | null = null;
    let requiresType = false;
    if (line.startsWith("- repair-arc-acceptance ")) payload = line.slice("- repair-arc-acceptance ".length);
    else if (line.startsWith("repair-arc-acceptance ")) payload = line.slice("repair-arc-acceptance ".length);
    else if (line.startsWith("- {") && line.endsWith("}")) { payload = line.slice(2); requiresType = true; }
    else if (line.startsWith("{") && line.endsWith("}")) { payload = line; requiresType = true; }
    if (payload === null) continue;
    try {
      const parsed = safeJsonParse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const expectedKeys = requiresType
        ? ["type", "recordedAt", "commit", "evidencePath"]
        : ["recordedAt", "commit", "evidencePath"];
      if (!exactObjectKeys(record, expectedKeys) || (requiresType && record.type !== "repair-arc-acceptance")
        || typeof record.recordedAt !== "number" || !Number.isInteger(record.recordedAt)
        || typeof record.commit !== "string" || typeof record.evidencePath !== "string") continue;
      records.push({
        recordedAt: record.recordedAt,
        commit: record.commit,
        evidencePath: record.evidencePath,
      });
    } catch {
      // Non-JSON Markdown lines and malformed unrelated JSON are not receipts.
    }
  }
  return records;
}

function isPreAcceptanceTechnicalReport(report: RepairArcReport): boolean {
  const acceptance = report.checks.filter((check) => check.id === "acceptance.log");
  return report.overall === "partial" && acceptance.length === 1 && acceptance[0]!.verdict === "PENDING"
    && report.checks.every((check) => check.id === "acceptance.log" || check.verdict === "PASS");
}

function collectAcceptanceLog(
  raw: RepairArcInput["acceptanceLog"],
  sourceCommits: Record<string, string | null>,
  now: number,
): RepairArcInput["acceptanceLog"] {
  if (!raw) return undefined;
  const fallback = {
    available: false,
    path: typeof raw.path === "string" ? raw.path : "",
    evidencePath: typeof raw.evidencePath === "string" ? raw.evidencePath : "",
    commit: typeof raw.commit === "string" ? raw.commit : "",
    recordedAt: typeof raw.recordedAt === "number" ? raw.recordedAt : 0,
  };
  try {
    if (!exactObjectKeys(raw as unknown as Record<string, unknown>, ["available", "path", "evidencePath", "commit", "recordedAt"])
      || raw.available !== true || !Number.isInteger(raw.recordedAt) || raw.recordedAt < R0_CUTOFF_MS || raw.recordedAt > now
      || typeof raw.path !== "string" || typeof raw.evidencePath !== "string" || typeof raw.commit !== "string") {
      throw new Error("acceptance receipt shape is invalid");
    }
    const expectedLog = `/opt/ai-vault/daily/${new Date(raw.recordedAt).toISOString().slice(0, 10)}.md`;
    if (raw.path !== expectedLog || !withinDefaultEvidenceRoot(raw.evidencePath)
      || !/^\d{8}T\d{6}Z\.json$/.test(basename(raw.evidencePath))) {
      throw new Error("acceptance receipt paths are invalid");
    }
    const logStat = lstatSync(raw.path);
    if (!logStat.isFile() || logStat.isSymbolicLink() || logStat.size <= 0 || logStat.size > 5 * 1024 * 1024
      || logStat.uid !== 0 || logStat.nlink !== 1
    ) throw new Error("acceptance log is not a trustworthy regular file");
    trustedTimestampedEvidenceStat(raw.evidencePath);
    const log = readBoundedRegularFile(raw.path, MAX_EVIDENCE_ARTIFACT_BYTES, "AI Vault acceptance log").toString("utf8");
    const matchingRecords = structuredAcceptanceRecords(log).filter((record) => record.recordedAt === raw.recordedAt
      && record.commit === raw.commit && record.evidencePath === raw.evidencePath);
    if (matchingRecords.length !== 1) throw new Error("AI Vault must contain exactly one matching structured repair-arc-acceptance line");
    const fileTimestamp = timestampFromEvidenceName(basename(raw.evidencePath));
    const evidence = readJson(raw.evidencePath);
    if (fileTimestamp === null || !validEnvelopeFrame(evidence, fileTimestamp, raw.recordedAt, sourceCommits)) {
      throw new Error("referenced technical-gates evidence has invalid report, provenance, or query windows");
    }
    if (!evidence.sourceClean.controlSurface || !evidence.sourceClean.mimounReprobe
      || !isPreAcceptanceTechnicalReport(evidence.report)) {
      throw new Error("referenced evidence did not pass every technical gate before logging");
    }
    if (sourceCommits.controlSurface !== raw.commit) throw new Error("acceptance receipt commit does not match the current candidate");
    return { ...raw, available: true };
  } catch (error) {
    return { ...fallback, error: sanitizeError(error) };
  }
}

async function fetchObservation(url: string, init?: RequestInit): Promise<{ status: number | null; json?: unknown; text?: string; contentType?: string; error?: string }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
    const contentType = response.headers.get("content-type") ?? "";
    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > HTTP_MAX_BODY_BYTES) {
      await response.body?.cancel();
      return { status: response.status, contentType, error: "endpoint body exceeds the bounded response limit" };
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let body = "";
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > HTTP_MAX_BODY_BYTES) {
          await reader.cancel();
          return { status: response.status, contentType, error: "endpoint body exceeds the bounded response limit" };
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    }
    if (contentType.includes("application/json") || /\+json(?:\s*;|$)/i.test(contentType)) {
      try { return { status: response.status, json: safeJsonParse(body), contentType }; }
      catch { return { status: response.status, contentType, error: "endpoint returned malformed JSON" }; }
    }
    return { status: response.status, text: body, contentType };
  } catch (error) {
    return { status: null, error: sanitizeError(error, [process.env.OPERATOR_TOKEN ?? ""]) };
  }
}

function valueAt(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function collectLive(baseUrl: string | undefined, candidateCommit: string | null, now: number): Promise<{
  r3?: RepairArcInput["r3"];
  surface?: RepairArcInput["liveSurface"];
}> {
  if (!baseUrl) return {};
  const health = await fetchObservation(`${baseUrl}/health`);
  const version = await fetchObservation(`${baseUrl}/api/version`);
  const shell = await fetchObservation(`${baseUrl}/models`);
  const anonymous = await fetchObservation(`${baseUrl}/api/models`);
  const token = process.env.OPERATOR_TOKEN;
  const authenticated = token
    ? await fetchObservation(`${baseUrl}/api/models`, { headers: { authorization: `Bearer ${token}` } })
    : { status: null as number | null, error: "operator authentication is not configured" };
  const service = systemdProperties("control-surface.service", ["ActiveState", "ActiveEnterTimestamp"]);
  const activeSince = timestampFromSystemd(service.values.ActiveEnterTimestamp);
  const serviceErrors = activeSince === null
    ? { available: false, rows: [] as Array<Record<string, unknown>>, error: "control-surface activation timestamp is unavailable" }
    : journalRows("control-surface.service", activeSince, now);
  const newErrorEntries = serviceErrors.available
    ? serviceErrors.rows.filter((row) => {
      const priority = Number(row.PRIORITY);
      return Number.isFinite(priority) && priority <= 3;
    }).length
    : null;
  const deployedCommitRaw = valueAt(version.json, "buildHash") ?? valueAt(version.json, "data", "buildHash")
    ?? valueAt(version.json, "commit") ?? valueAt(version.json, "data", "commit");
  const deployedCommit = typeof deployedCommitRaw === "string" ? deployedCommitRaw : null;
  const healthOk = valueAt(health.json, "ok") === true || valueAt(health.json, "data", "ok") === true;
  const commonError = health.error ?? version.error ?? shell.error ?? anonymous.error;
  return {
    r3: {
      available: anonymous.status !== null,
      error: anonymous.error ?? authenticated.error,
      anonymousStatus: anonymous.status,
      authenticatedStatus: authenticated.status,
      authConfigured: Boolean(token),
      payload: authenticated.json,
    },
    surface: {
      available: health.status !== null && version.status !== null && shell.status !== null && service.ok && serviceErrors.available,
      error: commonError ?? service.error ?? serviceErrors.error,
      healthStatus: health.status,
      healthOk,
      versionStatus: version.status,
      deployedCommit,
      candidateCommit,
      modelsShellStatus: shell.status,
      modelsShellContentType: shell.contentType ?? null,
      modelsShellMarker: typeof shell.text === "string" && /<div\s+id=["']root["']\s*>/i.test(shell.text),
      serviceActive: service.values.ActiveState === "active",
      newErrorEntries,
    },
  };
}

function isoFileStamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function stagedWrite(directory: string, label: string, payload: string): string {
  const path = join(directory, `.${label}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(path, "wx", 0o640);
    try {
      writeFileSync(fd, payload, "utf8");
      fchmodSync(fd, 0o440);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return path;
  } catch (error) {
    removeIfPresent(path);
    throw error;
  }
}

function removeIfPresent(path: string | null): void {
  if (!path) return;
  try { unlinkSync(path); } catch { /* best-effort cleanup of our unique temp */ }
}

function publishExclusive(stagedPath: string, finalPath: string): void {
  // A hard-link publish is atomic and refuses an existing final path. Both
  // paths are in the evidence directory, so no cross-filesystem fallback can
  // silently weaken the exclusive timestamp contract.
  linkSync(stagedPath, finalPath);
  removeIfPresent(stagedPath);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function currentBootId(): string {
  const bootId = readFileSync(BOOT_ID_PATH, "utf8").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId)) {
    throw new Error("kernel boot ID is unavailable or malformed");
  }
  return bootId;
}

function processStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    return startTicks && /^\d+$/.test(startTicks) ? startTicks : null;
  } catch {
    return null;
  }
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function recoverStaleWriterLock(lockPath: string, now: number): boolean {
  let fd: number | null = null;
  try {
    const before = lstatSync(lockPath);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.nlink !== 1
      || before.size <= 0 || before.size > 1_024 || (before.mode & 0o022) !== 0
      || before.mtimeMs > now - WRITER_LOCK_STALE_MS) return false;
    fd = openSync(lockPath, "r");
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) return false;
    const parsed = safeJsonParse(readFileSync(fd, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !exactObjectKeys(parsed as Record<string, unknown>, ["pid", "bootId", "processStartTicks", "createdAt"])) return false;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 1
      || typeof record.bootId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.bootId)
      || typeof record.processStartTicks !== "string" || !/^\d+$/.test(record.processStartTicks)
      || typeof record.createdAt !== "number" || !Number.isInteger(record.createdAt)
      || record.createdAt > now - WRITER_LOCK_STALE_MS || record.createdAt > before.mtimeMs + 5_000) return false;
    const bootId = currentBootId();
    if (record.bootId === bootId && processStartTicks(record.pid) === record.processStartTicks) return false;
    const current = lstatSync(lockPath);
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1) return false;
    unlinkSync(lockPath);
    fsyncDirectory(dirname(lockPath));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function acquireWriterLock(evidenceDir: string): { fd: number; path: string } {
  const lockPath = join(evidenceDir, ".writer.lock");
  const now = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stagePath = join(evidenceDir, `.writer-lock.${process.pid}.${randomUUID()}.tmp`);
    let stageFd: number | null = null;
    let published = false;
    try {
      stageFd = openSync(stagePath, "wx", 0o600);
      const startTicks = processStartTicks(process.pid);
      if (startTicks === null) throw new Error("current process start identity is unavailable");
      writeFileSync(stageFd, `${JSON.stringify({ pid: process.pid, bootId: currentBootId(), processStartTicks: startTicks, createdAt: now })}\n`, "utf8");
      fsyncSync(stageFd);
      linkSync(stagePath, lockPath);
      published = true;
      unlinkSync(stagePath);
      fsyncDirectory(evidenceDir);
      return { fd: stageFd, path: lockPath };
    } catch (error) {
      if (published && stageFd !== null) {
        releaseWriterLock(lockPath, stageFd);
        stageFd = null;
      }
      if (stageFd !== null) closeSync(stageFd);
      removeIfPresent(stagePath);
      if (errnoCode(error) === "EEXIST" && attempt === 0 && recoverStaleWriterLock(lockPath, now)) continue;
      throw error;
    }
  }
  throw new Error("writer lock could not be acquired");
}

function releaseWriterLock(lockPath: string, lockFd: number): void {
  try {
    const owned = fstatSync(lockFd);
    const current = lstatSync(lockPath);
    if (current.dev === owned.dev && current.ino === owned.ino && current.nlink === 1) unlinkSync(lockPath);
  } catch {
    // Never remove a path that cannot be proven to be our lock inode.
  } finally {
    closeSync(lockFd);
  }
}

function prepareEvidenceDirectory(evidenceDir: string): void {
  const root = resolve(DEFAULT_EVIDENCE_DIR);
  if (resolve(evidenceDir) !== root) {
    throw new CliArgumentError(`evidence directory must be exactly ${DEFAULT_EVIDENCE_DIR}`);
  }
  mkdirSync(root, { recursive: true, mode: 0o750 });
  if (lstatSync(root).isSymbolicLink() || lstatSync(root).uid !== 0 || realpathSync(root) !== root) {
    throw new CliArgumentError("default evidence root must be a real directory, not a symlink");
  }
  if ((lstatSync(root).mode & 0o022) !== 0) throw new CliArgumentError("default evidence root must not be group/world writable");
  let cursor = root;
  const suffix = relative(root, resolve(evidenceDir));
  for (const part of suffix ? suffix.split(sep) : []) {
    cursor = join(cursor, part);
    if (existsSync(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0) {
        throw new CliArgumentError("evidence directory contains a symlink or non-directory component");
      }
      if ((stat.mode & 0o022) !== 0) throw new CliArgumentError("evidence directories must not be group/world writable");
    } else {
      mkdirSync(cursor, { mode: 0o750 });
    }
  }
  if (!withinDefaultEvidenceRoot(realpathSync(evidenceDir))) {
    throw new CliArgumentError("evidence directory resolved outside the allowed root");
  }
}

function isLatestAcceptedEnvelope(envelope: EvidenceEnvelope): boolean {
  const fileTimestamp = Number.isInteger(envelope.generatedAt)
    ? Math.floor(envelope.generatedAt / 1_000) * 1_000
    : Number.NaN;
  const r1 = envelope.observations?.r1Current;
  return validFullSourceCommits(envelope.sourceCommits)
    && envelope.sourceClean?.controlSurface === true && envelope.sourceClean?.mimounReprobe === true
    && validEnvelopeFrame(envelope, fileTimestamp, envelope.generatedAt, envelope.sourceCommits)
    && r1 !== null && r1 !== undefined && validR1Observation(r1, envelope.generatedAt)
    && r1.scheduled === true && r1.invocationResult === "success"
    && r1.triggerReceiptVerified === true && r1.terminalReceiptVerified === true
    && typeof r1.bootId === "string" && /^[a-f0-9]{32}$/i.test(r1.bootId)
    && typeof r1.serviceJobId === "string" && /^\d+$/.test(r1.serviceJobId)
    && typeof r1.receiptTokenId === "string" && isUuidV4(r1.receiptTokenId)
    && typeof r1.triggerReceiptPath === "string"
    && /^\/var\/lib\/mimule\/model-fallback-reprobe\.triggers\/consumed\/trigger-\d{8}T\d{6}Z-[a-f0-9-]{36}\.json$/i.test(r1.triggerReceiptPath)
    && r1.triggerReceiptPath.endsWith(`-${r1.receiptTokenId}.json`)
    && isSha256(r1.triggerReceiptSha256)
    && typeof r1.terminalReceiptPath === "string"
    && /^\/var\/lib\/mimule\/model-fallback-reprobe\.receipts\/terminal-\d{8}T\d{6}Z-[a-f0-9-]{36}\.json$/i.test(r1.terminalReceiptPath)
    && r1.terminalReceiptPath.endsWith(`-${r1.receiptTokenId}.json`)
    && isSha256(r1.terminalReceiptSha256)
    && r1.execMainStatus === 0 && r1.invocationMode === "normal" && isSha256(r1.stateSha256)
    && envelope.observations.r1Failures.length === 0
    && validStoredReport(envelope.report, envelope.generatedAt)
    && envelope.report.overall === "verified"
    && envelope.report.checks.length === REQUIRED_CHECK_IDS.size
    && envelope.report.checks.every((check) => check.verdict === "PASS");
}

function recoverRecognizedLatestBackup(evidenceDir: string, latestPath: string): void {
  const pattern = /^\.latest-backup\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
  const backupPaths = readdirSync(evidenceDir).filter((name) => pattern.test(name)).map((name) => join(evidenceDir, name));
  if (!existsSync(latestPath)) {
    if (backupPaths.length > 0) throw new Error("orphan latest backup exists without latest-accepted.json");
    return;
  }
  const latest = lstatSync(latestPath);
  if (!latest.isFile() || latest.isSymbolicLink() || latest.uid !== 0 || latest.size <= 0
    || latest.size > MAX_EVIDENCE_ARTIFACT_BYTES || (latest.mode & 0o222) !== 0) {
    throw new Error("latest-accepted.json is not a trustworthy regular file");
  }
  if (latest.nlink === 2) {
    const matching = backupPaths.filter((path) => {
      const stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o222) === 0
        && stat.nlink === 2 && stat.dev === latest.dev && stat.ino === latest.ino && stat.size === latest.size;
    });
    if (matching.length !== 1 || backupPaths.length !== 1) {
      throw new Error("latest-accepted.json has an unrecognized hard-link state");
    }
    unlinkSync(matching[0]!);
    fsyncDirectory(evidenceDir);
    const recovered = lstatSync(latestPath);
    if (recovered.dev !== latest.dev || recovered.ino !== latest.ino || recovered.nlink !== 1) {
      throw new Error("latest-accepted.json backup-link recovery was unstable");
    }
    return;
  }
  if (latest.nlink !== 1) throw new Error("latest-accepted.json has an unrecognized hard-link count");
  if (backupPaths.length === 0) return;
  if (backupPaths.length !== 1) throw new Error("multiple stale latest backups require operator inspection");
  const backup = lstatSync(backupPaths[0]!);
  if (!backup.isFile() || backup.isSymbolicLink() || backup.uid !== 0 || backup.nlink !== 1
    || backup.size <= 0 || backup.size > MAX_EVIDENCE_ARTIFACT_BYTES || (backup.mode & 0o222) !== 0) {
    throw new Error("stale latest backup is not trustworthy");
  }
  const currentEnvelope = readJson(latestPath) as EvidenceEnvelope;
  const backupEnvelope = readJson(backupPaths[0]!) as EvidenceEnvelope;
  if (!isLatestAcceptedEnvelope(currentEnvelope) || !isLatestAcceptedEnvelope(backupEnvelope)
    || backupEnvelope.generatedAt >= currentEnvelope.generatedAt) {
    throw new Error("stale latest backup does not contain an older accepted envelope");
  }
  unlinkSync(backupPaths[0]!);
  fsyncDirectory(evidenceDir);
}

export function writeEvidenceSnapshot(
  evidenceDir: string,
  envelope: EvidenceEnvelope,
  secrets: readonly string[] = [],
): { evidencePath: string; latestAcceptedPath: string | null } {
  mkdirSync(evidenceDir, { recursive: true, mode: 0o750 });
  const clean = sanitizeForEvidence(envelope, secrets) as EvidenceEnvelope;
  // Serialize completely before creating either a staging or final file. A
  // cyclic or otherwise unserializable payload therefore leaves no artifact.
  const payload = `${JSON.stringify(clean, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_EVIDENCE_ARTIFACT_BYTES) {
    throw new Error("evidence payload exceeds the immutable history reader's 5 MiB bound");
  }
  const promoteLatest = isLatestAcceptedEnvelope(clean);
  if (clean.report?.overall === "verified" && !promoteLatest) {
    throw new Error("verified evidence envelope fails exact promotion provenance");
  }
  const evidencePath = join(evidenceDir, `${isoFileStamp(envelope.generatedAt)}.json`);
  let evidenceStage: string | null = null;
  let latestStage: string | null = null;
  let latestBackup: string | null = null;
  let preserveLatestBackup = false;
  let evidencePublished = false;
  let latestAcceptedPath: string | null = null;
  let lockPath = join(evidenceDir, ".writer.lock");
  let lockFd: number | null = null;
  try {
    const lock = acquireWriterLock(evidenceDir);
    lockFd = lock.fd;
    lockPath = lock.path;
    evidenceStage = stagedWrite(evidenceDir, "observation", payload);
    if (promoteLatest) {
      latestStage = stagedWrite(evidenceDir, "latest-accepted", payload);
      const existingLatest = join(evidenceDir, "latest-accepted.json");
      if (existsSync(existingLatest)) {
        recoverRecognizedLatestBackup(evidenceDir, existingLatest);
        const stat = lstatSync(existingLatest);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.nlink !== 1
          || (stat.mode & 0o222) !== 0 || stat.size <= 0 || stat.size > MAX_EVIDENCE_ARTIFACT_BYTES) {
          throw new Error("latest-accepted.json is not a trustworthy regular file");
        }
        const existing = readJson(existingLatest) as EvidenceEnvelope;
        if (!isLatestAcceptedEnvelope(existing) || existing.generatedAt >= envelope.generatedAt) {
          throw new Error("latest-accepted.json is not older than this verified observation");
        }
        latestBackup = join(evidenceDir, `.latest-backup.${process.pid}.${randomUUID()}.tmp`);
        linkSync(existingLatest, latestBackup);
      }
    }
    publishExclusive(evidenceStage, evidencePath);
    evidenceStage = null;
    evidencePublished = true;
    try {
      fsyncDirectory(evidenceDir);
    } catch (error) {
      unlinkSync(evidencePath);
      evidencePublished = false;
      throw error;
    }
    if (latestStage) {
      latestAcceptedPath = join(evidenceDir, "latest-accepted.json");
      try {
        renameSync(latestStage, latestAcceptedPath);
        latestStage = null;
        fsyncDirectory(evidenceDir);
        removeIfPresent(latestBackup);
        latestBackup = null;
      } catch (error) {
        // The accepted pointer is part of a verified publication. If it cannot
        // be replaced, retract the newly published timestamp before surfacing
        // failure so disk truth and the returned verdict cannot disagree.
        const rejected = join(evidenceDir, `.rejected.${process.pid}.${randomUUID()}.tmp`);
        try {
          renameSync(evidencePath, rejected);
          evidencePublished = false;
          unlinkSync(rejected);
        } catch {
          if (evidencePublished) {
            unlinkSync(evidencePath);
            evidencePublished = false;
          }
        }
        if (latestBackup) {
          try {
            renameSync(latestBackup, latestAcceptedPath);
            latestBackup = null;
          } catch { preserveLatestBackup = true; }
        } else {
          removeIfPresent(latestAcceptedPath);
        }
        throw error;
      }
    }
    return { evidencePath, latestAcceptedPath };
  } finally {
    removeIfPresent(evidenceStage);
    removeIfPresent(latestStage);
    if (!preserveLatestBackup) removeIfPresent(latestBackup);
    if (lockFd !== null) {
      releaseWriterLock(lockPath, lockFd);
      try { fsyncDirectory(evidenceDir); } catch { /* publication already reports its own fsync failures */ }
    }
  }
}

function mergeR2(collected: R2Input, operator: Partial<R2Input> | undefined): R2Input {
  if (!operator) return collected;
  const shadow = new Map<string, R2ShadowObservation>();
  for (const entry of [...(collected.shadowObservations ?? []), ...(operator.shadowObservations ?? [])]) {
    if (entry && typeof entry.invocationId === "string") shadow.set(entry.invocationId, entry);
  }
  return {
    ...collected,
    ...operator,
    rows: collected.rows,
    routes: collected.routes,
    pool: collected.pool,
    managedChains: collected.managedChains,
    managedChainsAvailable: collected.managedChainsAvailable,
    mode: collected.mode,
    liveModeEvidence: collected.liveModeEvidence,
    tombstones: collected.tombstones,
    durableRecoveryRule: collected.durableRecoveryRule,
    transientLedgerFailure: collected.transientLedgerFailure,
    enforcementStateVerified: collected.enforcementStateVerified,
    enforcementStateError: collected.enforcementStateError,
    exact429StateVerified: collected.exact429StateVerified,
    baselineVerified: collected.baselineVerified,
    shadowObservations: [...shadow.values()],
  };
}

function candidateTrackedClean(): { clean: boolean; error?: string } {
  const status = fixedCommand(["git", "-C", "/opt/opencode-control-surface", "status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) return { clean: false, error: status.error };
  const allowed = new Set(["e2e/fresh-host/REPORT.json", "e2e/fresh-host/REPORT.md"]);
  const relevant = status.stdout.split("\n").filter(Boolean).filter((line) => {
    const path = line.slice(3).trim().replace(/^"|"$/g, "");
    return !allowed.has(path);
  });
  return relevant.length === 0 ? { clean: true } : { clean: false, error: `candidate has ${relevant.length} relevant dirty path(s)` };
}

function mimounReprobeTrackedClean(): { clean: boolean; error?: string } {
  const status = fixedCommand([
    "git", "-C", "/opt/mimoun", "status", "--porcelain=v1", "--untracked-files=all", "--", "scripts/model-fallback-reprobe.py",
  ]);
  if (!status.ok) return { clean: false, error: status.error };
  return status.stdout.trim().length === 0
    ? { clean: true }
    : { clean: false, error: "Mimoun reprobe source is dirty or untracked" };
}

export async function runVerifier(options: CliOptions, now = Date.now()): Promise<{
  report: RepairArcReport;
  envelope: EvidenceEnvelope;
  evidencePath: string | null;
  exitCode: 0 | 2 | 3;
}> {
  prepareEvidenceDirectory(options.evidenceDir);
  if (process.env.OPERATOR_TOKEN && /[\x00-\x1f\x7f]/.test(process.env.OPERATOR_TOKEN)) {
    throw new CliArgumentError("OPERATOR_TOKEN contains control characters");
  }
  const operator = readOperatorInput(options.operatorInput);
  const worktree = candidateTrackedClean();
  const mimounWorktree = mimounReprobeTrackedClean();
  const sourceCommits = {
    controlSurface: gitCommit("/opt/opencode-control-surface"),
    mimoun: gitCommit("/opt/mimoun"),
  };
  const acceptanceLog = collectAcceptanceLog(operator.acceptanceLog, sourceCommits, now);
  const prior = loadPriorEvidence(options.evidenceDir, now, sourceCommits);
  const liveModeEvidence = collectR2LiveMode(DEFAULT_REPROBE_PATH, now);
  const r1 = collectR1(now, DEFAULT_REPROBE_PATH, prior.r1, prior.r2, prior.r1Failures);
  const ledger = readLedger(now);
  const managedChains = collectManagedChains();
  const collectedR2: R2Input = {
    available: Boolean(ledger.r2Rows),
    error: ledger.error,
    rows: ledger.r2Rows ?? [],
    recentCutoff: now - R2_RECENT_WINDOW_MS,
    routes: collectRoutes(r1.current),
    pool: r1.current?.pool ?? [],
    managedChains: managedChains.chains,
    managedChainsAvailable: managedChains.available,
    mode: "shadow",
    liveModeEvidence,
    enforcementStateVerified: false,
    enforcementStateError: "SPEC 46 enforcement is not implemented; no live enforcement state reader exists",
    exact429StateVerified: false,
    baselineVerified: false,
    shadowObservations: [
      ...prior.r2,
      ...(r1.r2Current ? [r1.r2Current] : []),
    ],
  };
  const live = await collectLive(options.baseUrl, sourceCommits.controlSurface, now);
  const editorialRaw = operator.realWork?.editorial ? {
    ...operator.realWork.editorial,
    priorFailures: [...(operator.realWork.editorial.priorFailures ?? []), ...prior.workFailures.editorial],
  } : undefined;
  const builderRaw = operator.realWork?.builder ? {
    ...operator.realWork.builder,
    priorFailures: [...(operator.realWork.builder.priorFailures ?? []), ...prior.workFailures.builder],
  } : undefined;
  const editorial = collectWorkRunReceipts(editorialRaw, "editorial", sourceCommits.controlSurface, now);
  const builder = collectWorkRunReceipts(builderRaw, "builder", sourceCommits.controlSurface, now);
  const realWork = editorial || builder ? { ...(editorial ? { editorial } : {}), ...(builder ? { builder } : {}) } : undefined;
  const validation = collectValidationManifest(operator.validation, sourceCommits.controlSurface, now, worktree.clean);
  const input: RepairArcInput = {
    ...operator,
    generatedAt: now,
    gatewayRows: ledger.r0Rows,
    gatewayError: ledger.error,
    evidenceHistory: {
      available: prior.available,
      sourceTreesClean: worktree.clean && mimounWorktree.clean,
      artifacts: prior.artifacts,
      r1Observations: prior.r1.length,
      r2Observations: prior.r2.length,
      error: prior.error,
    },
    r1: r1.input,
    r2: mergeR2(collectedR2, operator.r2),
    r3: live.r3 ?? operator.r3,
    liveSurface: live.surface ?? operator.liveSurface,
    realWork,
    validation,
    acceptanceLog,
  };
  let report = verifyRepairArc(input);
  let envelope: EvidenceEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    generatedAtUtc: new Date(now).toISOString(),
    sourceCommits,
    sourceClean: { controlSurface: worktree.clean, mimounReprobe: mimounWorktree.clean },
    cutoffs: { r0Unified: R0_CUTOFF_MS },
    queryWindows: {
      r0: { from: R0_CUTOFF_MS, to: now },
      r2Recent: { from: now - R2_RECENT_WINDOW_MS, to: now },
      r1Restarts: { from: now - 24 * 60 * 60 * 1_000, to: now },
    },
    observations: { r1Current: r1.current, r2Current: r1.r2Current, r1Failures: r1.failures },
    report,
  };
  let evidencePath: string | null = null;
  try {
    const written = writeEvidenceSnapshot(options.evidenceDir, envelope, [process.env.OPERATOR_TOKEN ?? ""]);
    evidencePath = written.evidencePath;
  } catch (error) {
    report = {
      ...report,
      checks: [...report.checks, {
        id: "evidence.write",
        verdict: "UNVERIFIABLE",
        note: `Timestamped evidence could not be written: ${sanitizeError(error, [process.env.OPERATOR_TOKEN ?? ""])}`,
        metrics: {},
        evidence: [],
      }],
    };
    report.overall = overallFromChecks(report.checks);
    envelope = { ...envelope, report };
  }
  return { report, envelope, evidencePath, exitCode: exitCodeForOverall(report.overall) };
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try { options = parseCliArgs(argv); }
  catch (error) {
    console.error(sanitizeError(error));
    console.error(usage());
    return 64;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  try {
    const outcome = await runVerifier(options);
    const safeOutput = sanitizeForEvidence(
      { evidencePath: outcome.evidencePath, ...outcome.report },
      [process.env.OPERATOR_TOKEN ?? ""],
    );
    console.log(JSON.stringify(safeOutput, null, 2));
    return outcome.exitCode;
  } catch (error) {
    console.error(`Verifier input error: ${sanitizeError(error, [process.env.OPERATOR_TOKEN ?? ""])}`);
    return error instanceof CliArgumentError ? 64 : 3;
  }
}

if (import.meta.main) process.exit(await main());
