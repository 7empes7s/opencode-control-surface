import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { classifyOpenCodeRoute, handleOpenCodeProxy, setOpenCodeProxyFetchForTests } from "./opencodeProxy.ts";
import { registerAgentSession, seedLegacyOpenCodeVisibilityReceipts } from "./registry.ts";
import { extractOpenCodeEventSessionId, parseOpenCodeSseFrames } from "./opencodeEventSpool.ts";

let root = "";
const priorToken = process.env.OPERATOR_TOKEN;

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-operator-token", "test-token");
  headers.set("host", "localhost");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-proxy-"));
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ enabled: true, path: join(root, "dashboard.sqlite") });
  seedLegacyOpenCodeVisibilityReceipts();
});

afterEach(() => {
  setOpenCodeProxyFetchForTests(null);
  closeDashboardDb();
  rmSync(root, { recursive: true, force: true });
  if (priorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorToken;
});

describe("OpenCode governed proxy", () => {
  test("deny-by-default method and path matrix", () => {
    expect(classifyOpenCodeRoute("GET", "/session")?.kind).toBe("session-list");
    expect(classifyOpenCodeRoute("POST", "/session/ses_abc/message")?.kind).toBe("session-direct");
    expect(classifyOpenCodeRoute("POST", "/permission/abc/reply")).toBeNull();
    expect(classifyOpenCodeRoute("GET", "/file")).toBeNull();
    expect(classifyOpenCodeRoute("PUT", "/session/ses_abc")).toBeNull();
  });

  test("unknown and hidden direct paths never reach upstream", async () => {
    let calls = 0;
    setOpenCodeProxyFetchForTests(async () => { calls += 1; return Response.json({}); });
    const unknown = await handleOpenCodeProxy(request("/opencode-api/file"), "/opencode-api/file", "");
    expect(unknown.status).toBe(404);
    const hidden = await handleOpenCodeProxy(
      request("/opencode-api/session/ses_08617347dffez44xNhAPaQudYa/message"),
      "/opencode-api/session/ses_08617347dffez44xNhAPaQudYa/message",
      "",
    );
    expect(hidden.status).toBe(404);
    expect(calls).toBe(0);
  });

  test("filters lists to the authenticated owner before serialization", async () => {
    registerAgentSession({
      tenantId: "mimule", ownerUserId: "operator-bootstrap", harness: "opencode",
      adapterSessionId: "ses_visible1", adapterVersion: "v2", title: "Visible",
      workspaceRoot: root, repositoryRoot: root, createdBy: "operator-bootstrap",
    });
    setOpenCodeProxyFetchForTests(async () => Response.json([
      { id: "ses_visible1", title: "Visible", directory: root },
      { id: "ses_unregistered1", title: "Unregistered", directory: root },
      { id: "ses_08617347dffez44xNhAPaQudYa", title: "Legacy probe", directory: "/" },
    ]));
    const response = await handleOpenCodeProxy(request("/opencode-api/session"), "/opencode-api/session", "");
    expect(response.status).toBe(200);
    expect((await response.json() as Array<{ id: string }>).map((session) => session.id)).toEqual(["ses_visible1"]);
  });

  test("ordinary clients cannot claim the reserved marker", async () => {
    let calls = 0;
    setOpenCodeProxyFetchForTests(async () => { calls += 1; return Response.json({}); });
    const response = await handleOpenCodeProxy(request("/opencode-api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: root, title: "__mimule_probe_v1__:spoof" }),
    }), "/opencode-api/session", "");
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("parses fragmented CRLF/multiline SSE data and extracts nested session ids", () => {
    const first = parseOpenCodeSseFrames('data: {"type":"message.updated",\r\ndata: "properties":{"info":{"sessionID":"ses_abc"}}}\r\n\r\npartial');
    expect(first.events).toHaveLength(1);
    expect(extractOpenCodeEventSessionId(first.events[0])).toBe("ses_abc");
    expect(first.remainder).toBe("partial");
  });
});
