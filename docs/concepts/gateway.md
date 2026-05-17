# Gateway Pillar

**Version**: 1.0.0

---

## Overview

The Gateway is the model's router and health monitor. Every AI request — whether from Builder, a direct API call, or an agent session — flows through the Gateway.

The Gateway's responsibilities:
1. **Route** requests to the appropriate model (local GPU or cloud fallback)
2. **Monitor** model health and latency
3. **Ledger** token/spend usage per tenant
4. **Enforce** model policies (allow/deny lists, fallback chains)

---

## Architecture

```
Client Request
     │
     ▼
┌─────────────┐
│   Gateway   │  ← /v1/chat/completions, /v1/models
└──────┬──────┘
       │
   ┌───┴───────────────────────────────┐
   │                                     │
   ▼                                     ▼
Local GPU                            Cloud Fallback
(gemma4:26b,                         (OpenRouter,
 qwen3:8b,                           GitHub Models,
 qwen2.5-coder:14b)                  DeepSeek)
   │                                     │
   └───────────── failover chain ─────────┘
```

---

## Model Selection

When a request comes in with a model name (e.g., `editorial-heavy`), the Gateway:

1. Checks the **allowlist** for that model
2. Checks the **health probe** for that model (is it responding under threshold?)
3. Routes to the backend (local or cloud)
4. If the backend fails, tries the **fallback chain** in order

Fallback chain for `editorial-heavy`:
```
local gemma4:26b → openrouter-deepseek-v3-free → github-gpt41 → [error]
```

---

## Health Probes

Every 5 hours (via `model-health-check.timer`), the Gateway tests each configured model:

- `latency_p50` — median response time
- `latency_p95` — 95th percentile
- `error_rate` — fraction of requests that errored
- `context_window_utilization` — how full the context window typically is

Results are written to `/var/lib/mimule/model-health.json` and read on every routing decision.

The `/api/gateway/stats` endpoint exposes live health metrics.

---

## Cost Ledger

Every request is logged to the cost ledger:

```typescript
interface LedgerEntry {
  timestamp: string;
  tenantId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  backend: "local" | "cloud";
  costMsat?: number;  // millisatoshis, for metered tenants
}
```

View the ledger via `GET /api/gateway/ledger`.

---

## Rate Limiting

The Gateway enforces rate limits per IP and per tenant:

| Endpoint | Limit |
|---|---|
| `/v1/chat/completions` | 120 req/min per IP |
| `/api/licensing/status` | 30 req/min per IP |
| `/api/telemetry/consent` | 30 req/min per IP |
| `/api/onboarding/step` | 30 req/min per IP |

When rate limited, returns `429 Too Many Requests` with `Retry-After` header.

---

## OpenAI Compatible Surface

The Gateway exposes an OpenAI-compatible endpoint at `/v1/chat/completions`. This allows:
- Standard OpenAI SDK usage
- Proxying to local models via the same interface
- Keeping the same client code when switching between local/cloud models

---

## Key Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/gateway/status` | Overall Gateway health |
| `GET /api/gateway/models` | List all configured models |
| `GET /api/gateway/ledger` | Query cost ledger entries |
| `GET /api/gateway/stats` | Live health statistics |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions |
| `GET /v1/models` | List available models (OpenAI format) |

---

## See Also

- [Quickstart](../quickstart.md) — route your first request through the Gateway
- [Builder Pillar](./builder.md) — workflows that use the Gateway for AI requests
- [API Reference](../reference/api.md) — full endpoint documentation