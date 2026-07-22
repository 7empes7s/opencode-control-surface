import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOperatorSessionCookie } from "../auth/session.ts";
import { appendAgentEvent, createAgentRun, registerAgentSession } from "../agentWorkspace/registry.ts";
import { handleApi } from "../api/router.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  getAgentIdentity,
  listAgentIdentities,
  saveAgentIdentityDeclaration,
  validateDeclaration,
} from "./agentIdentities.ts";

const NOW = 1_700_000_000_000;
let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevSessionSecret: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "agent-identities-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevSessionSecret = process.env.OPERATOR_SESSION_SECRET;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.OPERATOR_SESSION_SECRET = "agent-identities-test-secret";
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

function db() {
  return getDashboardDb()!;
}

function tenant(tenantId: string) {
  return testTenantContext({ tenantId });
}

function insertBuilderPass(id: string, tenantId: string, agent: string, status = "success"): void {
  db().query(`
    INSERT INTO builder_passes
      (id, run_id, workflow_id, sequence, phase, status, agent, started_at, finished_at, tenant_id)
    VALUES (?, ?, ?, 1, 'implement', ?, ?, ?, ?, ?)
  `).run(id, `run-${id}`, `workflow-${id}`, status, agent, NOW - 500, NOW, tenantId);
}

function insertGatewayCall(tenantId: string, caller: string): void {
  db().query(`
    INSERT INTO gateway_calls
      (ts, logical_model, resolved_model, backend, tier, success, caller, tenant_id)
    VALUES (?, 'logical', 'resolved', 'test', 'free', 1, ?, ?)
  `).run(NOW, caller, tenantId);
}

function insertAudit(tenantId: string, actor: string, actionKind = "coding.edit"): void {
  db().query(`
    INSERT INTO action_audit
      (ts, actor, action_kind, result_status, tenant_id)
    VALUES (?, ?, ?, 'success', ?)
  `).run(NOW, actor, actionKind, tenantId);
}

function seedUser(userId: string, role: "viewer" | "auditor" | "operator" | "owner", tenantId = "mimule"): void {
  db().query(`
    INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
    VALUES (?, ?, ?, 'local', ?, ?)
  `).run(userId, `${userId}@example.test`, userId, NOW, tenantId);
  db().query(`
    INSERT INTO governance_role_bindings (id, user_id, role, tenant_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(`binding-${userId}`, userId, role, tenantId, NOW);
}

function sessionRequest(userId: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-tenant-id": "mimule",
      cookie: issueOperatorSessionCookie(userId, "mimule"),
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

describe("agent identity declarations", () => {
  test("starts with four first-class identities in the honest undeclared state", () => {
    const identities = listAgentIdentities(tenant("t-alpha"));
    expect(identities.map((identity) => identity.definition.key)).toEqual([
      "codex-builder",
      "opencode-sessions",
      "autopipeline-stages",
      "hyperagent-broker",
    ]);
    expect(identities.every((identity) => identity.declaration.state === "undeclared")).toBe(true);
    expect(identities.every((identity) => identity.declaration.owner === null)).toBe(true);
    expect(identities.find((identity) => identity.definition.key === "autopipeline-stages")?.definition.evidenceCaveats[0]).toContain("No persisted per-stage");
    expect(identities.find((identity) => identity.definition.key === "hyperagent-broker")?.definition.evidenceCaveats[0]).toContain("advisory");
  });

  test("uses exact tenant-scoped builder, gateway, audit, session, run, and event evidence", () => {
    insertBuilderPass("alpha-codex", "t-alpha", "codex");
    insertBuilderPass("alpha-not-codex", "t-alpha", "claude");
    insertBuilderPass("beta-codex", "t-beta", "codex");
    insertGatewayCall("t-alpha", "codex-runner");
    insertGatewayCall("t-alpha", "not-codex");
    insertGatewayCall("t-beta", "codex-runner");
    insertAudit("t-alpha", "codex-runner");
    insertAudit("t-alpha", "not-codex");
    insertAudit("t-beta", "codex-runner");

    const session = registerAgentSession({
      tenantId: "t-alpha",
      ownerUserId: "operator",
      harness: "codex",
      adapterSessionId: "alpha-codex-session",
      adapterVersion: "test",
      title: "Codex test session",
      createdBy: "operator",
      createdAt: NOW - 1_000,
      updatedAt: NOW - 900,
    });
    const run = createAgentRun({ session, idempotencyKey: "alpha-codex-run", status: "running", createdAt: NOW - 800 });
    appendAgentEvent({ session, runId: run.id, kind: "test.event", payload: {}, createdAt: NOW - 700 });

    const identity = getAgentIdentity("codex-builder", tenant("t-alpha"))!;
    expect(identity.evidence.builderPasses).toMatchObject({ available: true, count: 1, successCount: 1, lastObservedAt: NOW });
    expect(identity.evidence.gatewayCalls).toMatchObject({ available: true, count: 1, successCount: 1, lastObservedAt: NOW });
    expect(identity.evidence.actionAudit).toMatchObject({ available: true, count: 1, lastObservedAt: NOW });
    expect(identity.evidence.sessions).toMatchObject({ available: true, sessions: 1, runs: 1, events: 1, lastObservedAt: NOW - 700 });

    const beta = getAgentIdentity("codex-builder", tenant("t-beta"))!;
    expect(beta.evidence.builderPasses.count).toBe(1);
    expect(beta.evidence.gatewayCalls.count).toBe(1);
    expect(beta.evidence.actionAudit.count).toBe(1);
    expect(beta.evidence.sessions).toMatchObject({ sessions: 0, runs: 0, events: 0 });
  });

  test("requires a complete human declaration before a profile becomes reviewed and never writes telemetry tables", () => {
    const beforeAudit = Number((db().query("SELECT COUNT(*) AS count FROM action_audit").get() as { count: number }).count);
    const partial = saveAgentIdentityDeclaration("codex-builder", {
      autonomyLevel: "propose",
      capabilities: [],
      owner: null,
      lastReviewedAt: null,
    }, "operator", tenant("t-alpha"), NOW);
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.identity.declaration.state).toBe("unreviewed");

    const complete = saveAgentIdentityDeclaration("codex-builder", {
      autonomyLevel: "act-with-approval",
      capabilities: ["edit scoped repository", "run declared checks", "edit scoped repository"],
      owner: "operator@example.test",
      lastReviewedAt: NOW,
    }, "operator", tenant("t-alpha"), NOW);
    expect(complete.ok).toBe(true);
    if (complete.ok) {
      expect(complete.identity.declaration).toMatchObject({
        state: "reviewed",
        autonomyLevel: "act-with-approval",
        capabilities: ["edit scoped repository", "run declared checks"],
        owner: "operator@example.test",
        lastReviewedAt: NOW,
      });
    }
    expect(getAgentIdentity("codex-builder", tenant("t-beta"))?.declaration.state).toBe("undeclared");
    expect(Number((db().query("SELECT COUNT(*) AS count FROM action_audit").get() as { count: number }).count)).toBe(beforeAudit);
    expect(Number((db().query("SELECT COUNT(*) AS count FROM agent_identity_profiles").get() as { count: number }).count)).toBe(1);

    const cleared = saveAgentIdentityDeclaration("codex-builder", {
      autonomyLevel: null,
      capabilities: [],
      owner: null,
      lastReviewedAt: null,
    }, "operator", tenant("t-alpha"), NOW + 1);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.identity.declaration.state).toBe("undeclared");
  });

  test("rejects invalid or falsely reviewed declarations", () => {
    expect(validateDeclaration({
      autonomyLevel: "autonomous",
      capabilities: ["read reports"],
      owner: "owner",
      lastReviewedAt: NOW + 1,
    }, NOW)).toMatchObject({ ok: false });
    expect(validateDeclaration({
      autonomyLevel: "propose",
      capabilities: [],
      owner: null,
      lastReviewedAt: NOW,
    }, NOW)).toMatchObject({ ok: false });
    expect(saveAgentIdentityDeclaration("not-real", {}, null, tenant("t-alpha"), NOW)).toMatchObject({ ok: false, status: 404 });
  });

  test("returns safe empty evidence when the dashboard database is unavailable", () => {
    closeDashboardDb();
    const identities = listAgentIdentities(tenant("t-alpha"));
    expect(identities).toHaveLength(4);
    expect(identities.every((identity) => identity.declaration.state === "undeclared")).toBe(true);
    expect(identities.every((identity) => identity.evidence.builderPasses.available === false)).toBe(true);
  });
});

describe("agent identity API gates", () => {
  test("does not expose posture data anonymously", async () => {
    const get = new Request("http://localhost/api/agent-identities");
    expect((await handleApi(get, new URL(get.url))).status).toBe(401);
    const put = new Request("http://localhost/api/agent-identities/codex-builder", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect((await handleApi(put, new URL(put.url))).status).toBe(401);
  });

  test("allows viewer reads, denies viewer writes, and limits writes to the new profile table", async () => {
    seedUser("viewer", "viewer");
    const read = sessionRequest("viewer", "/api/agent-identities");
    expect((await handleApi(read, new URL(read.url))).status).toBe(200);

    const blocked = sessionRequest("viewer", "/api/agent-identities/codex-builder", {
      method: "PUT",
      body: JSON.stringify({
        autonomyLevel: "read-only",
        capabilities: ["read reports"],
        owner: "viewer",
        lastReviewedAt: NOW,
      }),
    });
    expect((await handleApi(blocked, new URL(blocked.url))).status).toBe(403);
    expect(Number((db().query("SELECT COUNT(*) AS count FROM agent_identity_profiles").get() as { count: number }).count)).toBe(0);

    seedUser("operator", "operator");
    const auditBefore = Number((db().query("SELECT COUNT(*) AS count FROM action_audit").get() as { count: number }).count);
    const permitted = sessionRequest("operator", "/api/agent-identities/codex-builder", {
      method: "PUT",
      body: JSON.stringify({
        autonomyLevel: "read-only",
        capabilities: ["read reports"],
        owner: "operator",
        lastReviewedAt: NOW,
      }),
    });
    const response = await handleApi(permitted, new URL(permitted.url));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { identity: { declaration: { state: string; updatedBy: string | null } } } };
    expect(body.data.identity.declaration).toMatchObject({ state: "reviewed", updatedBy: "operator" });
    expect(Number((db().query("SELECT COUNT(*) AS count FROM agent_identity_profiles").get() as { count: number }).count)).toBe(1);
    expect(Number((db().query("SELECT COUNT(*) AS count FROM action_audit").get() as { count: number }).count)).toBe(auditBefore);
  });
});
