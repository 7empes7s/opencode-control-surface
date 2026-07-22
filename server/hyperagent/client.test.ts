import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type CapturedCall = {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

let originalFetch: typeof fetch;
let previousBrokerToken: string | undefined;
let previousConfirmationToken: string | undefined;
let createHyperagentThread: typeof import("./client.ts").createHyperagentThread;

beforeEach(async () => {
  // server/api/hyperagent.test.ts replaces this client at its API boundary.
  // Restore that test-only module replacement before importing the real
  // loopback client through an isolated specifier; the already-loaded API
  // handlers retain their own mocked bindings.
  mock.restore();
  ({ createHyperagentThread } = await import(`./client.ts?protocol-test=${Date.now()}-${Math.random()}`));
  originalFetch = globalThis.fetch;
  previousBrokerToken = process.env.HYPERAGENT_BROKER_TOKEN;
  previousConfirmationToken = process.env.HYPERAGENT_CONFIRMATION_TOKEN;
  process.env.HYPERAGENT_BROKER_TOKEN = "test-broker-token";
  process.env.HYPERAGENT_CONFIRMATION_TOKEN = "test-confirmation-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousBrokerToken === undefined) delete process.env.HYPERAGENT_BROKER_TOKEN;
  else process.env.HYPERAGENT_BROKER_TOKEN = previousBrokerToken;
  if (previousConfirmationToken === undefined) delete process.env.HYPERAGENT_CONFIRMATION_TOKEN;
  else process.env.HYPERAGENT_CONFIRMATION_TOKEN = previousConfirmationToken;
});

function captureFetch(calls: CapturedCall[], responder: (path: string) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      path: new URL(String(input)).pathname,
      headers: Object.fromEntries(headers.entries()),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return responder(new URL(String(input)).pathname);
  }) as typeof fetch;
}

describe("Hyperagent broker permit client", () => {
  test("uses the two-step broker protocol with identical argument binding and one consumption", async () => {
    const calls: CapturedCall[] = [];
    captureFetch(calls, (path) => path === "/confirm"
      ? Response.json({ confirmationToken: "broker-issued-permit" })
      : Response.json({ thread: { threadId: "thread-1" } }));

    const result = await createHyperagentThread("agent-1", "synthetic prompt", 2);

    expect(result).toEqual({ ok: true, status: 200, body: { thread: { threadId: "thread-1" } } });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.path)).toEqual(["/confirm", "/call"]);
    expect(calls[0].headers["x-broker-confirmation"]).toBe("test-confirmation-token");
    expect(calls[0].body).toEqual({
      tool: "create_thread",
      arguments: { agentId: "agent-1", prompt: "synthetic prompt" },
      maxCostUsd: 2,
    });
    expect(calls[1].body).toEqual({
      tool: "create_thread",
      arguments: { agentId: "agent-1", prompt: "synthetic prompt" },
      confirmationToken: "broker-issued-permit",
    });
  });

  test("never consumes when permit issuance is refused", async () => {
    const calls: CapturedCall[] = [];
    captureFetch(calls, () => Response.json({ error: "broker disabled" }, { status: 503 }));

    const result = await createHyperagentThread("agent-1", "synthetic prompt", 2);

    expect(result).toEqual({ ok: false, status: 503, error: "broker disabled" });
    expect(calls.map((call) => call.path)).toEqual(["/confirm"]);
  });

  test("fails closed before network access when either spend credential is absent", async () => {
    const calls: CapturedCall[] = [];
    captureFetch(calls, () => Response.json({ confirmationToken: "unexpected" }));
    delete process.env.HYPERAGENT_CONFIRMATION_TOKEN;

    const result = await createHyperagentThread("agent-1", "synthetic prompt", 2);

    expect(result).toEqual({ ok: false, status: 503, error: "hyperagent broker spend credentials are not configured" });
    expect(calls).toHaveLength(0);
  });
});
