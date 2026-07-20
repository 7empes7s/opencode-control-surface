import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type BrokerResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

const mockState: {
  readConfigured: boolean;
  spendConfigured: boolean;
  health: BrokerResult;
  status: BrokerResult;
  agents: BrokerResult;
  thread: BrokerResult;
  createThread: BrokerResult;
  createThreadCalls: Array<{ agentId: string; prompt: string; maxCostUsd: number }>;
} = {
  readConfigured: true,
  spendConfigured: true,
  health: { ok: true, status: 200, body: { ok: true, service: "hyperagent-broker", phase: "D5", disabled: false } },
  status: {
    ok: true,
    status: 200,
    body: {
      phase: "D5",
      budget: {
        hardCapUsd: 400, alertUsd: 300, maxPerTaskUsd: 25,
        spentUsd: 0, reservedUsd: 0, committedUsd: 0, tasks: 0, attempts: 0, overCap: false,
      },
      allowedCallers: ["control-surface", "operator-cli", "claude-session"],
      toolAllowlist: ["list_agents", "create_thread", "get_thread"],
    },
  },
  agents: { ok: true, status: 200, body: { agents: [{ id: "agent-1", name: "Agent One" }], count: 1 } },
  thread: {
    ok: true,
    status: 200,
    body: { thread: { threadId: "thread-1", status: "running", costUsd: null, messageCount: 1, urls: [] } },
  },
  createThread: {
    ok: true,
    status: 200,
    body: { thread: { threadId: "thread-1", status: "created", costUsd: null, messageCount: 0, urls: [] } },
  },
  createThreadCalls: [],
};

function resetMockState(): void {
  mockState.readConfigured = true;
  mockState.spendConfigured = true;
  mockState.health = { ok: true, status: 200, body: { ok: true, service: "hyperagent-broker", phase: "D5", disabled: false } };
  mockState.status = {
    ok: true,
    status: 200,
    body: {
      phase: "D5",
      budget: {
        hardCapUsd: 400, alertUsd: 300, maxPerTaskUsd: 25,
        spentUsd: 0, reservedUsd: 0, committedUsd: 0, tasks: 0, attempts: 0, overCap: false,
      },
      allowedCallers: ["control-surface", "operator-cli", "claude-session"],
      toolAllowlist: ["list_agents", "create_thread", "get_thread"],
    },
  };
  mockState.agents = { ok: true, status: 200, body: { agents: [{ id: "agent-1", name: "Agent One" }], count: 1 } };
  mockState.thread = {
    ok: true,
    status: 200,
    body: { thread: { threadId: "thread-1", status: "running", costUsd: null, messageCount: 1, urls: [] } },
  };
  mockState.createThread = {
    ok: true,
    status: 200,
    body: { thread: { threadId: "thread-1", status: "created", costUsd: null, messageCount: 0, urls: [] } },
  };
  mockState.createThreadCalls = [];
}

// The broker is a live, budget-bearing production service on 127.0.0.1:8787.
// Tests must never reach it — everything is mocked at the client boundary.
mock.module("../hyperagent/client.ts", () => ({
  hyperagentReadConfigured: () => mockState.readConfigured,
  hyperagentSpendConfigured: () => mockState.spendConfigured,
  getBrokerHealth: async () => mockState.health,
  getBrokerStatus: async () => mockState.status,
  listHyperagentAgents: async () => mockState.agents,
  getHyperagentThread: async () => mockState.thread,
  createHyperagentThread: async (agentId: string, prompt: string, maxCostUsd: number) => {
    // Mirrors the real client's own guard so tests exercise the same
    // "not configured" path the handler actually relies on.
    if (!mockState.spendConfigured) {
      return { ok: false, status: 503, error: "hyperagent broker spend credentials are not configured" };
    }
    mockState.createThreadCalls.push({ agentId, prompt, maxCostUsd });
    return mockState.createThread;
  },
}));

const { closeDashboardDb, getDashboardDb, initDashboardDb } = await import("../db/dashboard.ts");
const { handleApi } = await import("./router.ts");
const { issueOperatorSessionCookie } = await import("../auth/session.ts");
const { SAFE_AUTO_ACTIONS } = await import("../insights/autoapplyPolicy.ts");

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevSessionSecret: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  resetMockState();
  tempDir = mkdtempSync(join(tmpdir(), "hyperagent-api-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevSessionSecret = process.env.OPERATOR_SESSION_SECRET;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.OPERATOR_SESSION_SECRET = "hyperagent-api-test-secret";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  if (prevSessionSecret === undefined) delete process.env.OPERATOR_SESSION_SECRET;
  else process.env.OPERATOR_SESSION_SECRET = prevSessionSecret;
  rmSync(tempDir, { recursive: true, force: true });
});

function seedUser(userId: string, role: "owner" | "operator" | "auditor" | "viewer"): void {
  const db = getDashboardDb()!;
  db.query(
    `INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, `${userId}@example.test`, userId, "local", Date.now(), "mimule");
  db.query(
    `INSERT INTO governance_role_bindings (id, user_id, role, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`binding-${userId}`, userId, role, "mimule", Date.now());
}

function authedRequest(userId: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: issueOperatorSessionCookie(userId, "mimule"),
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

function anonRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://example.com${path}`, { ...init });
}

function latestAuditRow(): Record<string, unknown> | null {
  const db = getDashboardDb()!;
  return db.query(
    `SELECT * FROM action_audit WHERE action_kind = 'hyperagent.create_thread' ORDER BY id DESC LIMIT 1`,
  ).get() as Record<string, unknown> | null;
}

describe("GET /api/hyperagent/status", () => {
  test("anonymous access is 401", async () => {
    const res = await handleApi(anonRequest("/api/hyperagent/status"), new URL("http://example.com/api/hyperagent/status"));
    expect(res.status).toBe(401);
  });

  test("authenticated viewer can read status (relayed from the broker, not a second copy)", async () => {
    seedUser("viewer-user", "viewer");
    const req = authedRequest("viewer-user", "/api/hyperagent/status");
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { configured: boolean; phase: string; budget: { spentUsd: number }; attributionCaveat: string } };
    expect(body.data.configured).toBe(true);
    expect(body.data.phase).toBe("D5");
    expect(body.data.budget.spentUsd).toBe(0);
    expect(body.data.attributionCaveat).toContain("advisory");
  });

  test("reports configured:false without erroring when the broker token is absent", async () => {
    mockState.readConfigured = false;
    seedUser("viewer-user", "viewer");
    const req = authedRequest("viewer-user", "/api/hyperagent/status");
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { configured: boolean } };
    expect(body.data.configured).toBe(false);
  });
});

describe("GET /api/hyperagent/agents", () => {
  test("anonymous access is 401", async () => {
    const res = await handleApi(anonRequest("/api/hyperagent/agents"), new URL("http://example.com/api/hyperagent/agents"));
    expect(res.status).toBe(401);
  });

  test("authenticated request relays the broker's shaped agent list", async () => {
    seedUser("viewer-user", "viewer");
    const req = authedRequest("viewer-user", "/api/hyperagent/agents");
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { agents: Array<{ id: string; name: string | null }>; count: number } };
    expect(body.data.agents).toEqual([{ id: "agent-1", name: "Agent One" }]);
  });
});

describe("GET /api/hyperagent/threads/:id", () => {
  test("authenticated request relays the broker's shaped thread status", async () => {
    seedUser("viewer-user", "viewer");
    const req = authedRequest("viewer-user", "/api/hyperagent/threads/thread-1");
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { thread: { threadId: string; status: string } } };
    expect(body.data.thread.threadId).toBe("thread-1");
    expect(body.data.thread.status).toBe("running");
  });
});

describe("POST /api/hyperagent/create-thread — role gate", () => {
  const validBody = { agentId: "agent-1", prompt: "synthetic test prompt", maxCostUsd: 1, reason: "testing", confirmed: true };

  test("anonymous access is 401 and never reaches the broker", async () => {
    const req = anonRequest("/api/hyperagent/create-thread", { method: "POST", body: JSON.stringify(validBody) });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(401);
    expect(mockState.createThreadCalls.length).toBe(0);
  });

  test("viewer cannot invoke the spending action", async () => {
    seedUser("viewer-user", "viewer");
    const req = authedRequest("viewer-user", "/api/hyperagent/create-thread", { method: "POST", body: JSON.stringify(validBody) });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("Your role cannot make this change.");
    expect(mockState.createThreadCalls.length).toBe(0);
  });

  test("auditor cannot invoke the spending action", async () => {
    seedUser("auditor-user", "auditor");
    const req = authedRequest("auditor-user", "/api/hyperagent/create-thread", { method: "POST", body: JSON.stringify(validBody) });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(403);
    expect(mockState.createThreadCalls.length).toBe(0);
  });

  test("operator can invoke the spending action", async () => {
    seedUser("operator-user", "operator");
    const req = authedRequest("operator-user", "/api/hyperagent/create-thread", { method: "POST", body: JSON.stringify(validBody) });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(mockState.createThreadCalls).toEqual([{ agentId: "agent-1", prompt: "synthetic test prompt", maxCostUsd: 1 }]);
  });

  test("owner can invoke the spending action", async () => {
    seedUser("owner-user", "owner");
    const req = authedRequest("owner-user", "/api/hyperagent/create-thread", { method: "POST", body: JSON.stringify(validBody) });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(mockState.createThreadCalls.length).toBe(1);
  });
});

describe("POST /api/hyperagent/create-thread — request validation and audit", () => {
  test("requires confirmed === true before ever calling the broker", async () => {
    seedUser("operator-user", "operator");
    const req = authedRequest("operator-user", "/api/hyperagent/create-thread", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", prompt: "hi", reason: "testing", maxCostUsd: 1 }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("confirmation required");
    expect(mockState.createThreadCalls.length).toBe(0);

    const row = latestAuditRow();
    expect(row?.result_status).toBe("failed");
    expect(row?.error).toBe("confirmation required");
  });

  test("requires a reason", async () => {
    seedUser("operator-user", "operator");
    const req = authedRequest("operator-user", "/api/hyperagent/create-thread", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", prompt: "hi", maxCostUsd: 1, confirmed: true }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(400);
    expect(mockState.createThreadCalls.length).toBe(0);
  });

  test("rejects maxCostUsd above the per-task cap before calling the broker", async () => {
    seedUser("operator-user", "operator");
    const req = authedRequest("operator-user", "/api/hyperagent/create-thread", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", prompt: "hi", reason: "testing", maxCostUsd: 999, confirmed: true }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(400);
    expect(mockState.createThreadCalls.length).toBe(0);
  });

  test("a successful call writes a success audit row with the broker's response", async () => {
    seedUser("operator-user", "operator");
    const req = authedRequest("operator-user", "/api/hyperagent/create-thread", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", prompt: "hi there", reason: "verifying the panel", maxCostUsd: 2, confirmed: true }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { thread: { threadId: string } } };
    expect(body.data.thread.threadId).toBe("thread-1");

    const row = latestAuditRow();
    expect(row?.result_status).toBe("success");
    expect(row?.risk).toBe("high");
    expect(row?.reason).toBe("verifying the panel");
    expect(row?.target_type).toBe("hyperagent-thread");
    expect(row?.target_id).toBe("agent-1");
  });

  test("surfaces the broker's own refusal message verbatim, never reinterpreted", async () => {
    mockState.createThread = { ok: false, status: 402, error: "budget hard cap would be exceeded" };
    seedUser("operator-user", "operator");
    const req = authedRequest("operator-user", "/api/hyperagent/create-thread", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", prompt: "hi", reason: "testing", maxCostUsd: 5, confirmed: true }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("budget hard cap would be exceeded");

    const row = latestAuditRow();
    expect(row?.result_status).toBe("failed");
    expect(row?.error).toBe("budget hard cap would be exceeded");
  });

  test("is unavailable (503) when spend credentials are not configured, without touching the broker", async () => {
    mockState.spendConfigured = false;
    seedUser("operator-user", "operator");
    const req = authedRequest("operator-user", "/api/hyperagent/create-thread", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", prompt: "hi", reason: "testing", maxCostUsd: 1, confirmed: true }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(503);
  });
});

describe("hyperagent.create_thread is never auto-appliable", () => {
  test("no hyperagent action is present in SAFE_AUTO_ACTIONS", () => {
    for (const actionId of SAFE_AUTO_ACTIONS) {
      expect(actionId.includes("hyperagent")).toBe(false);
    }
  });
});
