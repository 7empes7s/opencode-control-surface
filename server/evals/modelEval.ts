import { loadGatewayConfig } from "../gateway/config.ts";
import { gatewayComplete as realGatewayComplete, type GatewayCompleteOptions } from "../gateway/router.ts";

// Injection seam for tests (mock.module leaks across bun test files; never use it here).
let gatewayComplete: typeof realGatewayComplete = realGatewayComplete;
export function setGatewayCompleteForTests(fn: typeof realGatewayComplete | null): void {
  gatewayComplete = fn ?? realGatewayComplete;
}
import { readOperatorState, writeOperatorState, writeMetricSample } from "../db/writer.ts";
import { isDashboardDbEnabled } from "../db/dashboard.ts";

const EVAL_PROMPT = "Summarize in one sentence why audit trails matter for autonomous AI agents.";
const EVAL_TIMEOUT_MS = 45_000;
const MAX_CANDIDATES = 3;
const DAILY_MARKER_KEY = "model-eval.daily-marker";
const SCHEDULER_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const SCHEDULER_TICK_MS = 60 * 1000; // check the daily marker every minute

const JUDGE_MODEL = "editorial-cloud-heavy";

export type ModelEvalResult = {
  model: string;
  score: number;
  latencyMs: number;
  answer: string;
  error?: string;
  ts: number;
};

export type ModelEvalRunOutcome = {
  ranAt: number;
  dateKey: string;
  skipped: boolean;
  skipReason?: string;
  results: ModelEvalResult[];
  errorCount: number;
};

type JudgeScores = {
  score: number;
  reason?: string;
};

function utcDateKey(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function pickCloudFreeModels(): string[] {
  let cfg: ReturnType<typeof loadGatewayConfig>;
  try {
    cfg = loadGatewayConfig();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const [name, entry] of Object.entries(cfg.models)) {
    if (entry.tier === "cloud-free") {
      out.push(name);
      if (out.length >= MAX_CANDIDATES) break;
    }
  }
  return out;
}

function readAnswerText(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  const rec = payload as Record<string, unknown>;
  if (typeof rec.answer === "string") return rec.answer;
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.content === "string") return rec.content;
  if (typeof rec.message === "string") return rec.message;
  // OpenAI-compatible shape: choices[0].message.content
  const choices = rec.choices as Array<{ message?: { content?: string | null } | null }> | undefined;
  const first = Array.isArray(choices) ? choices[0] : null;
  if (first && first.message && typeof first.message.content === "string") return first.message.content;
  console.log(`[readAnswerText] could not extract text from payload:`, JSON.stringify(rec).slice(0, 300));
  return "";
}

function extractScores(raw: string): JudgeScores {
  if (!raw) return { score: 0 };
  // Try a strict JSON parse first
  const tryParse = (snippet: string): JudgeScores | null => {
    try {
      const obj = JSON.parse(snippet) as Record<string, unknown>;
      const scoreVal = obj.score ?? obj.total ?? obj.rating;
      const score = Number(scoreVal);
      if (Number.isFinite(score) && score >= 0 && score <= 10) {
        return { score, reason: typeof obj.reason === "string" ? obj.reason : undefined };
      }
    } catch {
      /* fall through */
    }
    return null;
  };

  // 1) full string
  const full = tryParse(raw);
  if (full) return full;

  // 2) extract a JSON object embedded in code-fence / prose
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    const fromObj = tryParse(objectMatch[0]);
    if (fromObj) return fromObj;
  }

  // 3) last-resort: scan for a 1-10 integer/float
  const numericMatch = raw.match(/\b(10|[0-9](?:\.\d+)?)\b/);
  if (numericMatch) {
    const score = Number(numericMatch[1]);
    if (Number.isFinite(score) && score >= 0 && score <= 10) {
      return { score };
    }
  }
  return { score: 0 };
}

async function callOneModel(model: string, caller: string, timeoutMs: number): Promise<{ answer: string; latencyMs: number; error?: string }> {
  const opts: GatewayCompleteOptions = { caller, timeoutMs };
  const start = Date.now();
  try {
    const result = await gatewayComplete(
      model,
      {
        model,
        messages: [{ role: "user", content: EVAL_PROMPT }],
        temperature: 0.2,
        max_tokens: 200,
      },
      opts,
    );
    const choices = (result as { choices?: Array<{ message?: { content?: string | null } }> }).choices;
    const fallback = choices && choices[0] && choices[0].message ? String(choices[0].message.content ?? "") : "";
    const answer = readAnswerText(result) || fallback;
    return { answer: answer.trim(), latencyMs: Date.now() - start };
  } catch (e) {
    return { answer: "", latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
}

async function judgeAnswer(model: string, answer: string): Promise<JudgeScores> {
  if (!answer) return { score: 0 };
  const judgePrompt =
    `You are scoring an AI assistant's answer on a 1-10 scale for correctness and clarity.\n` +
    `Question: ${EVAL_PROMPT}\n` +
    `Answer: ${answer}\n` +
    `Respond with strict JSON: {"score": <integer 1-10>, "reason": "<short reason>"}.`;
  try {
    const res = await gatewayComplete(
      JUDGE_MODEL,
      {
        model: JUDGE_MODEL,
        messages: [{ role: "user", content: judgePrompt }],
        temperature: 0,
        max_tokens: 200,
      },
      { caller: "model-eval-judge", timeoutMs: EVAL_TIMEOUT_MS },
    );
    const text = readAnswerText(res);
    return extractScores(text);
  } catch (e) {
    console.warn(`[model-eval] judge call failed for ${model}:`, e instanceof Error ? e.message : e);
    return { score: 0 };
  }
}

function alreadyRanToday(dateKey: string): boolean {
  try {
    const marker = readOperatorState(DAILY_MARKER_KEY) as { date?: string; models?: number } | null;
    return Boolean(marker && marker.date === dateKey);
  } catch {
    return false;
  }
}

function markRanToday(dateKey: string, resultCount: number): void {
  try {
    writeOperatorState(DAILY_MARKER_KEY, { date: dateKey, ranAt: Date.now(), models: resultCount });
  } catch (e) {
    console.warn("[model-eval] failed to write daily marker:", e);
  }
}

export async function runModelEvalOnce(now: number = Date.now()): Promise<ModelEvalRunOutcome> {
  const dateKey = utcDateKey(now);
  const baseOutcome: ModelEvalRunOutcome = {
    ranAt: now,
    dateKey,
    skipped: false,
    results: [],
    errorCount: 0,
  };

  if (!isDashboardDbEnabled()) {
    return { ...baseOutcome, skipped: true, skipReason: "DASHBOARD_DB disabled" };
  }

  if (alreadyRanToday(dateKey)) {
    return { ...baseOutcome, skipped: true, skipReason: "already ran today" };
  }

  const candidates = pickCloudFreeModels();
  if (candidates.length === 0) {
    markRanToday(dateKey, 0);
    return { ...baseOutcome, skipped: true, skipReason: "no cloud-free models in config" };
  }

  const results: ModelEvalResult[] = [];
  for (const model of candidates) {
    const call = await callOneModel(model, "model-eval", EVAL_TIMEOUT_MS);
    const judged = call.error ? { score: 0 } : await judgeAnswer(model, call.answer);
    const result: ModelEvalResult = {
      model,
      score: judged.score,
      latencyMs: call.latencyMs,
      answer: call.answer,
      error: call.error,
      ts: Date.now(),
    };
    results.push(result);

    try {
      writeMetricSample({
        source: "model-eval",
        key: model,
        value: {
          score: result.score,
          latencyMs: result.latencyMs,
          ts: result.ts,
          dateKey,
          error: result.error ?? null,
        },
      });
    } catch (e) {
      console.warn(`[model-eval] metric write failed for ${model}:`, e);
    }
  }

  const errorCount = results.filter((r) => r.error || r.score === 0).length;
  markRanToday(dateKey, results.length);

  return { ranAt: now, dateKey, skipped: false, results, errorCount };
}

// ── Scheduler (additive) ────────────────────────────────────────────────────

let evalTimer: ReturnType<typeof setInterval> | null = null;
let lastTickRanAt = 0;

async function tick(): Promise<void> {
  // Coarse coalescing so concurrent ticks (e.g. multi-process) don't duplicate work.
  const now = Date.now();
  if (now - lastTickRanAt < 30_000) return;
  lastTickRanAt = now;
  try {
    await runModelEvalOnce(now);
  } catch (e) {
    console.warn("[model-eval] tick failed:", e instanceof Error ? e.message : e);
  }
}

export function startModelEvalScheduler(): void {
  if (evalTimer) return;
  // Fire-and-forget; the marker + ts gating inside runModelEvalOnce prevents
  // re-running more than once per UTC day.
  tick().catch(() => undefined);
  evalTimer = setInterval(tick, SCHEDULER_INTERVAL_MS);
  evalTimer.unref?.();
}

export function stopModelEvalScheduler(): void {
  if (evalTimer) {
    clearInterval(evalTimer);
    evalTimer = null;
  }
}

// Re-export for tests that need to drive the scheduler in-process.
export const __TESTING__ = { SCHEDULER_INTERVAL_MS, SCHEDULER_TICK_MS, DAILY_MARKER_KEY, MAX_CANDIDATES, JUDGE_MODEL };
