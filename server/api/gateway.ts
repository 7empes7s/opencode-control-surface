import { ok } from "./types.ts";
import { gatewayComplete, gatewayModels, getCircuitStates } from "../gateway/router.ts";
import { ledgerStats, readLedger } from "../gateway/ledger.ts";
import { loadGatewayConfig } from "../gateway/config.ts";

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiError(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

// GET /api/gateway/status — circuit states + config summary
export function gatewayStatusHandler(): Response {
  const cfg = loadGatewayConfig();
  const circuits = getCircuitStates();
  return json(ok({
    version: cfg.version,
    litellmUrl: cfg.litellmUrl,
    modelCount: Object.keys(cfg.models).length,
    circuits,
  }));
}

// GET /api/gateway/models — list all known models
export async function gatewayModelsHandler(): Promise<Response> {
  try {
    const list = await gatewayModels();
    return json(ok({ models: list }));
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 502);
  }
}

// GET /api/gateway/ledger?limit=N&model=X
export function gatewayLedgerHandler(url: URL): Response {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 500);
  const logicalModel = url.searchParams.get("model") ?? undefined;
  const onlyFailed = url.searchParams.get("failed") === "1";
  const rows = readLedger({ limit, logicalModel, onlyFailed });
  return json(ok({ rows }));
}

// GET /api/gateway/stats?since=<ms>
export function gatewayStatsHandler(url: URL): Response {
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? Number(sinceRaw) : Date.now() - 24 * 60 * 60 * 1000;
  const stats = ledgerStats(since);
  return json(ok(stats));
}

// POST /v1/chat/completions — OpenAI-compatible surface
export async function v1ChatCompletionsHandler(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return apiError("invalid JSON body", 400);
  }

  const model = String(body.model ?? "editorial-heavy");
  const messages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (!messages?.length) return apiError("messages required", 400);

  try {
    const result = await gatewayComplete(model, {
      model,
      messages: messages.map((m) => ({ role: m.role as "user" | "system" | "assistant", content: m.content })),
      temperature: body.temperature as number | undefined,
      max_tokens: body.max_tokens as number | undefined,
    }, { caller: "v1-surface" });
    return json(result);
  } catch (e) {
    return json({ error: { message: e instanceof Error ? e.message : String(e), type: "gateway_error" } }, 502);
  }
}

// GET /v1/models — OpenAI-compatible models listing
export async function v1ModelsHandler(): Promise<Response> {
  const list = await gatewayModels().catch(() => []);
  return json({ object: "list", data: list });
}
