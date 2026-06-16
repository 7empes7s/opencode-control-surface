import "../gateway/test-gateway-config.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { v1ChatCompletionsHandler } from "../api/gateway.ts";
import { createGatewayKey } from "../gateway/keys.ts";
import { seedDefaultAgents } from "../agents/registry.ts";
import type { CompletionResponse } from "../gateway/adapters/base.ts";

declare global {
  // eslint-disable-next-line no-var
  var __gatewayKeysMockFetch: typeof fetch | null | undefined;
  // eslint-disable-next-line no-var
  var __gatewayKeysOriginalFetch: typeof fetch | null | undefined;
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

function withTestTenantContext<R>(context: { tenantId: string }, fn: () => R): R {
  return tenantStore.run(testTenantContext(context), fn);
}

type CapturedCall = { url: string; body: unknown };

type AdapterMock = {
  calls: CapturedCall[];
  setResponse: (resp: CompletionResponse) => void;
  restore: () => void;
};

function installAdapterMock(): AdapterMock {
  const calls: CapturedCall[] = [];
  let response: CompletionResponse = {
    id: "mock-default",
    object: "chat.completion",
    created: 1700000000,
    model: "test-model",
    choices: [
      { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  const mockFetch: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      if (url.includes("/v1/chat/completions")) {
        const rawBody = init?.body;
        let parsed: unknown = rawBody;
        if (typeof rawBody === "string") {
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            parsed = rawBody;
          }
        }
        calls.push({ url, body: parsed });
        return new Response(JSON.stringify(response), {
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

  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch;

  return {
    calls,
    setResponse: (r: CompletionResponse) => {
      response = r;
    },
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "gateway-passthrough-test-"));
  mkdirSync(tempDir, { recursive: true });
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });

  withTestTenantContext({ tenantId: "mimule" }, () => {
    seedDefaultAgents();
    const conn = getDashboardDb()!;
    const now = Date.now();
    conn.query(`
      INSERT OR IGNORE INTO agents
        (id, name, kind, owner, purpose, risk_tier, status, model_access, aliases_json, created_at, updated_at, tenant_id)
      VALUES (?, ?, 'runner', 'test', 'test', 'low', 'active', '', '[]', ?, ?, 'mimule')
    `).run("passthrough-agent", "passthrough-agent", now, now);
  });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  rmSync(tempDir, { recursive: true, force: true });
});

function v1Request(opts: { auth?: string; body: unknown }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) headers["authorization"] = opts.auth;
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body),
  });
}

async function makeAgentKey(): Promise<string> {
  return withTestTenantContext({ tenantId: "mimule" }, () => {
    const created = createGatewayKey("passthrough-agent", "passthrough test key");
    return created.key;
  });
}

describe("v1ChatCompletionsHandler — OpenAI passthrough", () => {
  test("JSON mode preserves tool_calls and finish_reason verbatim from LiteLLM", async () => {
    const mock = installAdapterMock();
    try {
      const toolCall = {
        id: "call_abc",
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
      };
      mock.setResponse({
        id: "chatcmpl-tool-1",
        object: "chat.completion",
        created: 1700000001,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [toolCall] },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });

      const key = await makeAgentKey();
      const res = await v1ChatCompletionsHandler(
        v1Request({
          auth: `Bearer ${key}`,
          body: { model: "test-model", messages: [{ role: "user", content: "weather in Paris?" }] },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);

      const body = await res.json() as {
        id: string;
        choices: Array<{
          finish_reason: string | null;
          message: { role: string; content: string | null; tool_calls: unknown };
        }>;
      };
      expect(body.id).toBe("chatcmpl-tool-1");
      expect(body.choices[0].finish_reason).toBe("tool_calls");
      expect(body.choices[0].message.role).toBe("assistant");
      expect(body.choices[0].message.content).toBeNull();
      expect(body.choices[0].message.tool_calls).toEqual([toolCall]);
    } finally {
      mock.restore();
    }
  });

  test("SSE mode emits delta.tool_calls with index fields and finish_reason 'tool_calls'", async () => {
    const mock = installAdapterMock();
    try {
      const toolCallA = {
        id: "call_alpha",
        type: "function",
        function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
      };
      const toolCallB = {
        id: "call_beta",
        type: "function",
        function: { name: "summarize", arguments: "{\"len\":2}" },
      };
      mock.setResponse({
        id: "chatcmpl-tool-2",
        object: "chat.completion",
        created: 1700000002,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [toolCallA, toolCallB] },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });

      const key = await makeAgentKey();
      const res = await v1ChatCompletionsHandler(
        v1Request({
          auth: `Bearer ${key}`,
          body: {
            model: "test-model",
            stream: true,
            messages: [{ role: "user", content: "do the things" }],
          },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

      const text = await res.text();
      const frames = text
        .split("\n\n")
        .map((frame) => frame.trim())
        .filter((frame) => frame.startsWith("data:") && !frame.endsWith("[DONE]"))
        .map((frame) => JSON.parse(frame.replace(/^data:\s*/, "")));

      expect(frames.length).toBe(3); // first delta, final delta with finish_reason, empty done chunk

      const first = frames[0] as {
        id: string;
        object: string;
        choices: Array<{
          index: number;
          delta: {
            role: string;
            content?: string | null;
            tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason: string | null;
        }>;
      };
      expect(first.id).toBe("chatcmpl-tool-2");
      expect(first.object).toBe("chat.completion.chunk");
      expect(first.choices[0].index).toBe(0);
      expect(first.choices[0].delta.role).toBe("assistant");
      expect(first.choices[0].finish_reason).toBeNull();
      expect(Array.isArray(first.choices[0].delta.tool_calls)).toBe(true);
      const firstDeltaCalls = first.choices[0].delta.tool_calls!;
      expect(firstDeltaCalls.length).toBe(2);
      expect(firstDeltaCalls[0].index).toBe(0);
      expect(firstDeltaCalls[0].id).toBe("call_alpha");
      expect(firstDeltaCalls[0].type).toBe("function");
      expect(firstDeltaCalls[0].function?.name).toBe("lookup");
      expect(firstDeltaCalls[0].function?.arguments).toBe("{\"q\":\"x\"}");
      expect(firstDeltaCalls[1].index).toBe(1);
      expect(firstDeltaCalls[1].id).toBe("call_beta");
      expect(firstDeltaCalls[1].function?.name).toBe("summarize");
      // No content delta when the message had no text content.
      expect(first.choices[0].delta.content).toBeUndefined();

      const final = frames[1] as {
        choices: Array<{ delta: unknown; finish_reason: string | null }>;
      };
      expect(final.choices[0].finish_reason).toBe("tool_calls");
      expect(final.choices[0].delta).toEqual({});

      const done = frames[2] as { choices: unknown[] };
      expect(done.choices).toEqual([]);

      expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("SSE mode includes content in the first delta when the response had text", async () => {
    const mock = installAdapterMock();
    try {
      mock.setResponse({
        id: "chatcmpl-text",
        object: "chat.completion",
        created: 1700000003,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello there" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });

      const key = await makeAgentKey();
      const res = await v1ChatCompletionsHandler(
        v1Request({
          auth: `Bearer ${key}`,
          body: {
            model: "test-model",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          },
        }),
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      const frames = text
        .split("\n\n")
        .map((frame) => frame.trim())
        .filter((frame) => frame.startsWith("data:") && !frame.endsWith("[DONE]"))
        .map((frame) => JSON.parse(frame.replace(/^data:\s*/, "")));
      const first = frames[0] as {
        choices: Array<{ delta: { role?: string; content?: string | null; tool_calls?: unknown } }>;
      };
      expect(first.choices[0].delta.role).toBe("assistant");
      expect(first.choices[0].delta.content).toBe("Hello there");
      expect(first.choices[0].delta.tool_calls).toBeUndefined();

      const final = frames[1] as { choices: Array<{ finish_reason: string | null }> };
      expect(final.choices[0].finish_reason).toBe("stop");
    } finally {
      mock.restore();
    }
  });

  test("tools field is forwarded verbatim to the LiteLLM adapter", async () => {
    const mock = installAdapterMock();
    try {
      const tools = [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Look up the weather for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "send_email",
            parameters: { type: "object", properties: { to: { type: "string" } } },
          },
        },
      ];
      const toolChoice = { type: "function", function: { name: "get_weather" } };
      const responseFormat = { type: "json_object" as const };
      const stop = ["END", "STOP"];
      const requestBody = {
        model: "test-model",
        messages: [
          { role: "system" as const, content: "You can use tools." },
          { role: "user" as const, content: "weather?" },
        ],
        tools,
        tool_choice: toolChoice,
        response_format: responseFormat,
        stop,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        seed: 42,
        user: "agent-007",
        temperature: 0.5,
        max_tokens: 256,
      };

      const key = await makeAgentKey();
      const res = await v1ChatCompletionsHandler(
        v1Request({ auth: `Bearer ${key}`, body: requestBody }),
      );
      expect(res.status).toBe(200);

      expect(mock.calls.length).toBe(1);
      const forwarded = mock.calls[0].body as Record<string, unknown>;
      expect(forwarded.model).toBe("test-model");
      expect(forwarded.tools).toEqual(tools);
      expect(forwarded.tool_choice).toEqual(toolChoice);
      expect(forwarded.response_format).toEqual(responseFormat);
      expect(forwarded.stop).toEqual(stop);
      expect(forwarded.top_p).toBe(0.9);
      expect(forwarded.frequency_penalty).toBe(0.1);
      expect(forwarded.presence_penalty).toBe(0.2);
      expect(forwarded.seed).toBe(42);
      expect(forwarded.user).toBe("agent-007");
      expect(forwarded.temperature).toBe(0.5);
      expect(forwarded.max_tokens).toBe(256);
      expect(forwarded.messages).toEqual(requestBody.messages);

      // The handler must not invent tool_calls in the request body.
      expect((forwarded as { tool_calls?: unknown }).tool_calls).toBeUndefined();
    } finally {
      mock.restore();
    }
  });

  test("passthrough fields are not invented when absent on the request", async () => {
    const mock = installAdapterMock();
    try {
      const key = await makeAgentKey();
      const res = await v1ChatCompletionsHandler(
        v1Request({
          auth: `Bearer ${key}`,
          body: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
        }),
      );
      expect(res.status).toBe(200);
      expect(mock.calls.length).toBe(1);
      const forwarded = mock.calls[0].body as Record<string, unknown>;
      expect(forwarded.tools).toBeUndefined();
      expect(forwarded.tool_choice).toBeUndefined();
      expect(forwarded.response_format).toBeUndefined();
      expect(forwarded.stop).toBeUndefined();
      expect(forwarded.top_p).toBeUndefined();
      expect(forwarded.frequency_penalty).toBeUndefined();
      expect(forwarded.presence_penalty).toBeUndefined();
      expect(forwarded.seed).toBeUndefined();
      expect(forwarded.user).toBeUndefined();
    } finally {
      mock.restore();
    }
  });

  test("multi-turn tool messages flow verbatim: assistant.tool_calls + role:'tool'.tool_call_id are preserved byte-identical", async () => {
    const mock = installAdapterMock();
    try {
      const assistantToolCall = {
        id: "call_xyz",
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
      };
      const requestMessages = [
        { role: "system" as const, content: "You can use tools." },
        { role: "user" as const, content: "weather in Paris?" },
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [assistantToolCall],
        },
        {
          role: "tool" as const,
          tool_call_id: "call_xyz",
          content: "{\"temp_c\":18,\"summary\":\"clear\"}",
        },
        { role: "user" as const, content: "and tomorrow?" },
      ];
      const requestBody = {
        model: "test-model",
        messages: requestMessages,
      };

      const key = await makeAgentKey();
      const res = await v1ChatCompletionsHandler(
        v1Request({ auth: `Bearer ${key}`, body: requestBody }),
      );
      expect(res.status).toBe(200);

      expect(mock.calls.length).toBe(1);
      const forwarded = mock.calls[0].body as { messages: unknown[]; model: string };
      expect(forwarded.model).toBe("test-model");
      expect(forwarded.messages).toEqual(requestMessages);
      // Byte-identical means: no new keys added, no keys removed, no reordering,
      // no per-entry .map() that strips tool_calls / tool_call_id.
      expect(JSON.stringify(forwarded.messages)).toBe(JSON.stringify(requestMessages));
    } finally {
      mock.restore();
    }
  });

  test("malformed messages are rejected with 400 — non-object entry", async () => {
    const mock = installAdapterMock();
    try {
      const key = await makeAgentKey();
      const res = await v1ChatCompletionsHandler(
        v1Request({
          auth: `Bearer ${key}`,
          body: { model: "test-model", messages: ["just-a-string"] },
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json() as { error?: string };
      expect(body.error).toMatch(/messages required|string 'role'/i);
      // Mock must not have been called when the request was rejected pre-routing.
      expect(mock.calls.length).toBe(0);
    } finally {
      mock.restore();
    }
  });

  test("malformed messages are rejected with 400 — object with non-string role", async () => {
    const mock = installAdapterMock();
    try {
      const key = await makeAgentKey();
      const res = await v1ChatCompletionsHandler(
        v1Request({
          auth: `Bearer ${key}`,
          body: {
            model: "test-model",
            messages: [{ role: 123, content: "hi" } as unknown as { role: "user"; content: string }],
          },
        }),
      );
      expect(res.status).toBe(400);
      expect(mock.calls.length).toBe(0);
    } finally {
      mock.restore();
    }
  });
});
