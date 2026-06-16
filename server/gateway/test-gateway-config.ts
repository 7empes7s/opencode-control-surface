// Side-effect-only module imported FIRST by server/gateway/keys.test.ts.
// Stubs globalThis.fetch so that any LiteLLM call during the v1 test
// returns a deterministic mock completion, regardless of the cached
// gateway config. The stub is set at import time so it is in place
// before any other module (including the transitive load of
// gateway/config.ts via ../api/gateway.ts → ../gateway/router.ts →
// ../gateway/config.ts) can call fetch.
import type { CompletionResponse } from "./adapters/base.ts";

declare global {
  // eslint-disable-next-line no-var
  var __gatewayKeysMockFetch: typeof fetch | null | undefined;
  // eslint-disable-next-line no-var
  var __gatewayKeysOriginalFetch: typeof fetch | null | undefined;
}

if (!globalThis.__gatewayKeysOriginalFetch) {
  globalThis.__gatewayKeysOriginalFetch = globalThis.fetch;

  const mockResponse: CompletionResponse = {
    id: "mock-1",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  const mockFetch: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      if (url.includes("/v1/chat/completions")) {
        return new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
    { preconnect: () => {} },
  ) as typeof fetch;

  globalThis.__gatewayKeysMockFetch = mockFetch;
  globalThis.fetch = mockFetch;
}
