import { gatewayComplete, gatewayModels } from "./router.ts";
import type { CompletionMessage, CompletionResponse } from "./adapters/base.ts";

export type { CompletionMessage, CompletionResponse };

export async function complete(
  logicalModel: string,
  messages: CompletionMessage[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    traceId?: string | null;
    caller?: string;
  } = {},
): Promise<CompletionResponse> {
  return gatewayComplete(logicalModel, {
    model: logicalModel,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  }, {
    timeoutMs: opts.timeoutMs,
    traceId: opts.traceId,
    caller: opts.caller,
  });
}

export async function models() {
  return gatewayModels();
}

export { getCircuitStates } from "./router.ts";
export { ledgerStats, readLedger } from "./ledger.ts";
export { loadGatewayConfig } from "./config.ts";
