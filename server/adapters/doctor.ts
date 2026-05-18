import { openSync, fstatSync, readSync, closeSync } from "node:fs";

const DOCTOR_LOG_PATH = "/var/lib/mimule/doctor-log.jsonl";
const TAIL_BYTES = 512 * 1024;       // 512 KB — home stats
const FULL_TAIL_BYTES = 2 * 1024 * 1024; // 2 MB — detail page
const WINDOW_MS = 24 * 60 * 60 * 1000;
const HOT_WINDOW_MS = 10 * 60 * 1000;

export interface DoctorEntry {
  ts: string;
  slug?: string;
  stage?: string;
  action?: string;
  applied?: boolean;
  reason?: string;
  errorType?: string;
  class?: string;
  failedModel?: string;
  model?: string;
  diagnosis?: string;
  nextStage?: string;
  cooldownMs?: number;
}

function tailJsonl(path: string, maxBytes = TAIL_BYTES): DoctorEntry[] {
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch { return []; }

  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, size));
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    if (start > 0) lines.shift(); // first line may be truncated
    const entries: DoctorEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

function top<T extends string>(map: Map<T, number>, n = 5): { key: T; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function isRateLimitErrorType(type: string): boolean {
  const normalized = type.toLowerCase();
  return normalized.includes("capacity_rate_limit") ||
    normalized.includes("rate_limit") ||
    normalized.includes("ratelimit") ||
    normalized.includes("rate limit") ||
    normalized.includes("429");
}

function providerFromModel(model: string): string {
  const normalized = model.toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("/")) return normalized.split("/")[0];
  if (normalized.startsWith("openrouter-") || normalized.includes("openrouter")) return "openrouter";
  if (normalized.startsWith("groq-") || normalized.includes("groq")) return "groq";
  if (normalized.startsWith("github-") || normalized.includes("github")) return "github";
  if (normalized.startsWith("cerebras-") || normalized.includes("cerebras")) return "cerebras";
  if (normalized.startsWith("alibaba-") || normalized.includes("alibaba")) return "alibaba";
  if (normalized.startsWith("opencode-") || normalized.includes("opencode")) return "opencode";
  if (normalized.startsWith("zen-") || normalized.includes("zen")) return "zen";
  if (normalized.startsWith("editorial-") || normalized.startsWith("coding-") || normalized.startsWith("mimule-")) return "local";
  return "unknown";
}

function classifyDiagnosis(diagnosis: string | undefined): string {
  const normalized = diagnosis?.toLowerCase() ?? "";
  if (!normalized) {
    return "";
  }
  if (
    normalized.includes("insufficient_quota") ||
    normalized.includes("quota") ||
    normalized.includes("spending cap") ||
    normalized.includes("billing")
  ) {
    return "quota";
  }
  if (
    normalized.includes("ratelimit") ||
    normalized.includes("rate limit") ||
    normalized.includes("rate_limit") ||
    normalized.includes("429")
  ) {
    return "rate_limit";
  }
  return "";
}

export function getDoctorEntryErrorType(entry: DoctorEntry): string {
  const diagnosisClass = classifyDiagnosis(entry.diagnosis);
  if (entry.errorType) {
    return entry.errorType;
  }
  if (diagnosisClass && (!entry.class || entry.class === "unknown")) {
    return diagnosisClass;
  }
  return entry.class || diagnosisClass;
}

export function getDoctorEntryFailedModel(entry: DoctorEntry): string {
  return entry.failedModel || entry.model || "";
}

export function getDoctorEntryReason(entry: DoctorEntry): string {
  return entry.reason || entry.diagnosis || "";
}

export interface DoctorStats {
  total: number;
  success: number;
  errorClasses: { type: string; count: number }[];
  topFailingModels: { model: string; count: number }[];
  topFailingStages: { stage: string; count: number }[];
  verdictMix: { action: string; count: number }[];
  rateLimitProviders: { provider: string; count: number; models: string[]; storySlugs: string[] }[];
  fallbackCascades: { model: string; stage: string; count: number; errorType: string; storySlugs: string[] }[];
  lastDecision: { ts: string; slug: string; action: string; reason: string } | null;
}

export function getDoctorStats(): DoctorStats {
  const entries = tailJsonl(DOCTOR_LOG_PATH);
  const cutoff = Date.now() - WINDOW_MS;
  const recent = entries.filter((e) => new Date(e.ts).getTime() >= cutoff);

  // Deduplicate: pipeline can log the same decision twice in quick succession.
  // Use a compound key of ts+slug+stage+action.
  const seen = new Set<string>();
  const deduped: DoctorEntry[] = [];
  for (const e of recent) {
    const key = `${e.ts}|${e.slug}|${e.stage}|${e.action}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(e); }
  }

  const errorMap = new Map<string, number>();
  const modelMap = new Map<string, number>();
  const stageMap = new Map<string, number>();
  const actionMap = new Map<string, number>();
  const providerSignals = new Map<string, { count: number; models: Set<string>; storySlugs: Set<string> }>();
  const fallbackSignals = new Map<string, { model: string; stage: string; count: number; errorType: string; storySlugs: Set<string> }>();
  const hotCutoff = Date.now() - HOT_WINDOW_MS;
  let cascadeKey = "";

  for (const e of deduped) {
    const errorType = getDoctorEntryErrorType(e);
    const failedModel = getDoctorEntryFailedModel(e);
    if (errorType) errorMap.set(errorType, (errorMap.get(errorType) ?? 0) + 1);
    if (failedModel) modelMap.set(failedModel, (modelMap.get(failedModel) ?? 0) + 1);
    if (e.stage) stageMap.set(e.stage, (stageMap.get(e.stage) ?? 0) + 1);
    if (e.action) actionMap.set(e.action, (actionMap.get(e.action) ?? 0) + 1);

    const entryTs = new Date(e.ts).getTime();
    if (entryTs >= hotCutoff && isRateLimitErrorType(errorType)) {
      const provider = providerFromModel(failedModel);
      const signal = providerSignals.get(provider) ?? { count: 0, models: new Set<string>(), storySlugs: new Set<string>() };
      signal.count += 1;
      if (failedModel) signal.models.add(failedModel);
      if (e.slug) signal.storySlugs.add(e.slug);
      providerSignals.set(provider, signal);
    }

    const nextCascadeKey = failedModel && e.stage && errorType ? `${e.stage}|${failedModel}` : "";
    if (nextCascadeKey && nextCascadeKey === cascadeKey) {
      const signal = fallbackSignals.get(nextCascadeKey);
      if (signal) {
        signal.count += 1;
        if (e.slug) signal.storySlugs.add(e.slug);
      }
    } else if (nextCascadeKey) {
      fallbackSignals.set(nextCascadeKey, {
        model: failedModel,
        stage: e.stage ?? "unknown",
        count: 1,
        errorType,
        storySlugs: new Set(e.slug ? [e.slug] : []),
      });
    }
    cascadeKey = nextCascadeKey;
  }

  // LLM doctor uses: retry, retry_escalate, skip_stage (positive), kill, no_action, dead_content (negative)
  // Rule-based doctor uses: requeued, promoted (positive), dead-content, escalate (negative)
  const SUCCESS_ACTIONS = new Set(["requeued", "promoted", "retry", "retry_escalate", "skip_stage"]);
  const success = deduped.filter((e) => e.action && SUCCESS_ACTIONS.has(e.action) && e.applied !== false).length;
  const last = deduped[deduped.length - 1] ?? null;

  return {
    total: deduped.length,
    success,
    errorClasses: top(errorMap).map(({ key, count }) => ({ type: key, count })),
    topFailingModels: top(modelMap, 3).map(({ key, count }) => ({ model: key, count })),
    topFailingStages: top(stageMap, 3).map(({ key, count }) => ({ stage: key, count })),
    verdictMix: top(actionMap).map(({ key, count }) => ({ action: key, count })),
    rateLimitProviders: [...providerSignals.entries()]
      .filter(([, signal]) => signal.count > 3)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([provider, signal]) => ({
        provider,
        count: signal.count,
        models: [...signal.models].slice(0, 5),
        storySlugs: [...signal.storySlugs].slice(0, 10),
      })),
    fallbackCascades: [...fallbackSignals.values()]
      .filter((signal) => signal.count > 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((signal) => ({
        model: signal.model,
        stage: signal.stage,
        count: signal.count,
        errorType: signal.errorType,
        storySlugs: [...signal.storySlugs].slice(0, 10),
      })),
    lastDecision: last
      ? { ts: last.ts, slug: last.slug ?? "", action: last.action ?? "", reason: getDoctorEntryReason(last) }
      : null,
  };
}

export interface FullLogOpts {
  stage?: string;
  errorType?: string;
  failedModel?: string;
  since?: number; // epoch ms
}

export function getFullLog(opts: FullLogOpts = {}): DoctorEntry[] {
  const all = tailJsonl(DOCTOR_LOG_PATH, FULL_TAIL_BYTES);

  const seen = new Set<string>();
  const deduped: DoctorEntry[] = [];
  for (const e of all) {
    const key = `${e.ts}|${e.slug}|${e.stage}|${e.action}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(e); }
  }

  return deduped.filter((e) => {
    if (opts.since && new Date(e.ts).getTime() < opts.since) return false;
    if (opts.stage && e.stage !== opts.stage) return false;
    if (opts.errorType && e.errorType !== opts.errorType) return false;
    if (opts.failedModel && e.failedModel !== opts.failedModel) return false;
    return true;
  });
}
