import { lstatSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const DEFAULT_MANIFEST_PATH = "/opt/know/web/ops/control-surface.json";
const MAX_ARTIFACT_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type KnowArtifact<T extends JsonRecord = JsonRecord> = {
  state: "ok" | "missing" | "malformed";
  modifiedAt: string | null;
  ageSeconds: number | null;
  value: T | null;
};

type KnowManifest = JsonRecord & {
  id?: string;
  product?: string;
  label?: string;
  root?: string;
  service?: string;
  defaultPlan?: string;
  services?: string[];
  urls?: { local?: string; public?: string; healthPath?: string };
  artifacts?: Record<string, { path?: string; freshnessMinutes?: number }>;
  timers?: Array<{ id?: string; unit?: string; schedule?: string; observeOnly?: boolean }>;
  models?: { logicalNames?: string[]; stages?: Record<string, string> };
  workflow?: { stages?: string[] };
  separation?: { owns?: string[]; neverReads?: string[] };
};

function manifestPath(): string {
  return process.env.DASHBOARD_KNOW_MANIFEST_PATH?.trim() || DEFAULT_MANIFEST_PATH;
}

function readBoundedJson<T extends JsonRecord>(path: string): KnowArtifact<T> {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
      return { state: "malformed", modifiedAt: stat.mtime.toISOString(), ageSeconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)), value: null };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected object");
    return {
      state: "ok",
      modifiedAt: stat.mtime.toISOString(),
      ageSeconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)),
      value: parsed as T,
    };
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
    return { state: missing ? "missing" : "malformed", modifiedAt: null, ageSeconds: null, value: null };
  }
}

function nestedRecord(value: unknown, key: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const nested = (value as JsonRecord)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as JsonRecord : {};
}

function artifactPath(manifest: KnowManifest | null, key: string, fallback: string): string {
  const fromManifest = manifest?.artifacts?.[key]?.path;
  return process.env[`DASHBOARD_KNOW_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}_PATH`]?.trim()
    || fromManifest
    || fallback;
}

let knowFetch: typeof fetch = fetch;

export function setKnowFetchForTests(fn: typeof fetch | null): void {
  knowFetch = fn ?? fetch;
}

export async function readKnowSources(): Promise<{
  manifest: KnowArtifact<KnowManifest>;
  health: KnowArtifact;
  operations: KnowArtifact;
  doctor: KnowArtifact;
  runtime: { reachable: boolean; status: number | null; checkedAt: string; value: JsonRecord | null };
}> {
  const manifest = readBoundedJson<KnowManifest>(manifestPath());
  const manifestValue = manifest.value?.id === "know" && manifest.value?.product === "know" && manifest.value?.root === "/opt/know/web"
    ? manifest.value
    : null;
  if (manifest.state === "ok" && !manifestValue) {
    manifest.state = "malformed";
    manifest.value = null;
  }

  const health = readBoundedJson(artifactPath(manifestValue, "health", "/var/lib/mimule/know-health.json"));
  const operations = readBoundedJson(artifactPath(manifestValue, "opsSnapshot", "/var/lib/mimule/know-ops.json"));
  const doctor = readBoundedJson(artifactPath(manifestValue, "doctor", "/var/lib/mimule/know-doctor.json"));
  const base = process.env.DASHBOARD_KNOW_BASE_URL?.trim() || manifestValue?.urls?.local || "http://127.0.0.1:3400";
  const healthPath = manifestValue?.urls?.healthPath || "/health";
  const checkedAt = new Date().toISOString();
  let runtime: { reachable: boolean; status: number | null; checkedAt: string; value: JsonRecord | null };
  try {
    const response = await knowFetch(new URL(healthPath, base), { signal: AbortSignal.timeout(2_500) });
    const parsed = await response.json().catch(() => null);
    runtime = {
      reachable: response.ok && Boolean(parsed && typeof parsed === "object" && (parsed as JsonRecord).service === "know"),
      status: response.status,
      checkedAt,
      value: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : null,
    };
  } catch {
    runtime = { reachable: false, status: null, checkedAt, value: null };
  }
  return { manifest, health, operations, doctor, runtime };
}

export function getKnowNested(value: unknown, key: string): JsonRecord {
  return nestedRecord(value, key);
}

const KNOW_SERVICES = ["know-web", "know-health", "know-ops", "know-doctor"] as const;
const KNOW_TIMERS = ["know-health", "know-ops", "know-doctor", "know-push-streak"] as const;

function exactSystemctl(command: string): string {
  try {
    return execSync(command, { encoding: "utf8", timeout: 2_500 });
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? (error as { stdout?: unknown }).stdout : "";
    return Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout || "");
  }
}

/** Exact Know-only unit probes; deliberately avoids global discovery fan-out. */
export function readKnowUnits(): {
  services: Array<{ name: string; status: "active" | "inactive" | "failed" | "unknown" }>;
  timers: Array<{ name: string; active: boolean; lastTrigger: string | null; nextElapse: string | null; lastResult: string | null; observeOnly: boolean }>;
} {
  const serviceOutput = exactSystemctl(`systemctl is-active ${KNOW_SERVICES.join(" ")} 2>/dev/null || true`);
  const serviceStates = serviceOutput.trim().split("\n");
  const services = KNOW_SERVICES.map((name, index) => {
    const state = serviceStates[index]?.trim();
    return { name, status: state === "active" || state === "inactive" || state === "failed" ? state : "unknown" } as const;
  });

  const timerOutput = exactSystemctl(`systemctl show ${KNOW_TIMERS.map((name) => `${name}.timer`).join(" ")} --property=Id,ActiveState,LastTriggerUSec,NextElapseUSecRealtime,Result 2>/dev/null || true`);
  const byId = new Map<string, Record<string, string>>();
  for (const block of timerOutput.split(/\n\s*\n/)) {
    const properties: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const equals = line.indexOf("=");
      if (equals > 0) properties[line.slice(0, equals)] = line.slice(equals + 1);
    }
    if (properties.Id) byId.set(properties.Id.replace(/\.timer$/, ""), properties);
  }
  const timers = KNOW_TIMERS.map((name) => {
    const properties = byId.get(name) ?? {};
    return {
      name,
      active: properties.ActiveState === "active",
      lastTrigger: properties.LastTriggerUSec && properties.LastTriggerUSec !== "n/a" ? properties.LastTriggerUSec : null,
      nextElapse: properties.NextElapseUSecRealtime && properties.NextElapseUSecRealtime !== "n/a" ? properties.NextElapseUSecRealtime : null,
      lastResult: properties.Result || null,
      observeOnly: name === "know-push-streak",
    };
  });
  return { services, timers };
}
