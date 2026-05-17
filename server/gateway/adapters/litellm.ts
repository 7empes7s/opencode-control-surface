import type { ProviderAdapter, CompletionRequest, CompletionResponse, ModelInfo, HealthResult } from "./base.ts";

export class LiteLLMAdapter implements ProviderAdapter {
  constructor(private readonly baseUrl: string) {}

  async complete(req: CompletionRequest, timeoutMs = 120_000): Promise<CompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`LiteLLM ${res.status}: ${body.slice(0, 200)}`);
      }
      return await res.json() as CompletionResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async models(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];
      const body = await res.json() as { data?: ModelInfo[] };
      return body.data ?? [];
    } catch {
      return [];
    }
  }

  async health(model: string, timeoutMs = 8_000): Promise<HealthResult> {
    const start = Date.now();
    try {
      const res = await this.complete(
        { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, temperature: 0 },
        timeoutMs,
      );
      const latencyMs = Date.now() - start;
      const ok = res.choices.length > 0;
      return { ok, latencyMs };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
