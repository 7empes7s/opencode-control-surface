import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readJob } from "../db/writer.ts";
import { _resetGatewayConfigCacheForTests } from "../gateway/config.ts";
import { getGatewayRouteOverrideForGatewayAdmin, getGatewayRoutePlanForGatewayAdmin, resetGatewayRouteOverrideStateForTests } from "../gateway/router.ts";
import { executeActionHandler } from "./execute.ts";

describe("executeActionHandler", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;
  let previousCooldownsPath: string | undefined;
  let previousGatewayConfig: string | undefined;
  let previousDossiersRoot: string | undefined;
  let previousNewsBitesDeployCommand: string | undefined;
  let previousArticlesPath: string | undefined;
  let previousPublicPath: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "execute-api-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    previousCooldownsPath = process.env.DASHBOARD_MODEL_COOLDOWNS_PATH;
    previousGatewayConfig = process.env.GATEWAY_CONFIG;
    previousDossiersRoot = process.env.DASHBOARD_DOSSIERS_ROOT;
    previousNewsBitesDeployCommand = process.env.DASHBOARD_NEWSBITES_DEPLOY_CMD;
    previousArticlesPath = process.env.DASHBOARD_CONTENT_ARTICLES_PATH;
    previousPublicPath = process.env.DASHBOARD_CONTENT_PUBLIC_PATH;
    originalFetch = globalThis.fetch;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    process.env.DASHBOARD_MODEL_COOLDOWNS_PATH = join(tempDir, "model-cooldowns.json");
    process.env.GATEWAY_CONFIG = join(tempDir, "gateway.yaml");
    process.env.DASHBOARD_DOSSIERS_ROOT = join(tempDir, "dossiers");
    mkdirSync(process.env.DASHBOARD_DOSSIERS_ROOT, { recursive: true });
    globalThis.fetch = (() => Promise.reject(new Error("network disabled in execute tests"))) as unknown as typeof fetch;
    writeFileSync(process.env.GATEWAY_CONFIG, `
version: 1
litellm_url: http://127.0.0.1:4000
models:
  editorial-heavy:
    backend: litellm
    model: editorial-heavy-resolved
    tier: local
  editorial-fast:
    backend: litellm
    model: editorial-fast-resolved
    tier: cloud-free
`);
    _resetGatewayConfigCacheForTests();
    resetGatewayRouteOverrideStateForTests();
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    resetGatewayRouteOverrideStateForTests();
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    if (previousCooldownsPath === undefined) delete process.env.DASHBOARD_MODEL_COOLDOWNS_PATH;
    else process.env.DASHBOARD_MODEL_COOLDOWNS_PATH = previousCooldownsPath;
    if (previousGatewayConfig === undefined) delete process.env.GATEWAY_CONFIG;
    else process.env.GATEWAY_CONFIG = previousGatewayConfig;
    if (previousDossiersRoot === undefined) delete process.env.DASHBOARD_DOSSIERS_ROOT;
    else process.env.DASHBOARD_DOSSIERS_ROOT = previousDossiersRoot;
    if (previousNewsBitesDeployCommand === undefined) delete process.env.DASHBOARD_NEWSBITES_DEPLOY_CMD;
    else process.env.DASHBOARD_NEWSBITES_DEPLOY_CMD = previousNewsBitesDeployCommand;
    if (previousArticlesPath === undefined) delete process.env.DASHBOARD_CONTENT_ARTICLES_PATH;
    else process.env.DASHBOARD_CONTENT_ARTICLES_PATH = previousArticlesPath;
    if (previousPublicPath === undefined) delete process.env.DASHBOARD_CONTENT_PUBLIC_PATH;
    else process.env.DASHBOARD_CONTENT_PUBLIC_PATH = previousPublicPath;
    globalThis.fetch = originalFetch;
    _resetGatewayConfigCacheForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeRequest(body: unknown) {
    const res = await executeActionHandler(
      new Request("http://x/api/actions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    const result = await res.json();
    return { status: res.status, result };
  }

  function seedIncident(id: string) {
    getDashboardDb()!.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count, representative_pass_id, representative_diagnosis_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, `${id}:cluster`, "test_failure", "Test incident", 1, 1, 1, "pass-1", "diagnosis-1", "open");
  }

  it("governs and dispatches run:newsbites:deploy through the hermetic command seam", async () => {
    const confirmation = await makeRequest({
      actionId: "run:newsbites:deploy",
      reason: "test deploy",
    });
    expect(confirmation.status).toBe(400);
    expect(confirmation.result.code).toBe("CONFIRM_REQUIRED");

    const reason = await makeRequest({
      actionId: "run:newsbites:deploy",
      confirmed: true,
    });
    expect(reason.status).toBe(400);
    expect(reason.result.code).toBe("REASON_REQUIRED");

    const unknown = await makeRequest({
      actionId: "run:newsbites:unknown",
      confirmed: true,
      reason: "test unknown target",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.result.code).toBe("NOT_FOUND");

    const articlesRoot = join(tempDir, "articles");
    const publicRoot = join(tempDir, "public");
    mkdirSync(articlesRoot, { recursive: true });
    mkdirSync(publicRoot, { recursive: true });
    process.env.DASHBOARD_CONTENT_ARTICLES_PATH = articlesRoot;
    process.env.DASHBOARD_CONTENT_PUBLIC_PATH = publicRoot;
    process.env.DASHBOARD_NEWSBITES_DEPLOY_CMD = "echo hermetic-deploy";

    const { status, result } = await makeRequest({
      actionId: "run:newsbites:deploy",
      confirmed: true,
      reason: "test deploy",
    });

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("run");
    expect(result.jobId).toBeString();
    expect(result.message).toBe(`NewsBites deploy started — poll /api/newsbites/deploy/${result.jobId}`);

    let job = readJob(result.jobId);
    for (let attempt = 0; attempt < 100 && !job?.outputTail.includes("[content-health]"); attempt++) {
      await Bun.sleep(10);
      job = readJob(result.jobId);
    }
    expect(job?.status).toBe("success");
    expect(job?.outputTail).toContain("hermetic-deploy");

    const audit = getDashboardDb()!.query(`
      SELECT action_id, risk, reason, result_status
      FROM action_audit
      WHERE action_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get("run:newsbites:deploy") as { action_id: string; risk: string; reason: string; result_status: string } | null;
    expect(audit).toEqual({
      action_id: "run:newsbites:deploy",
      risk: "medium",
      reason: "test deploy",
      result_status: "success",
    });
  });

  it("1. missing actionId returns 400 BAD_REQUEST", async () => {
    const { status, result } = await makeRequest({});
    expect(status).toBe(400);
    expect(result.code).toBe("BAD_REQUEST");
  });

  it("2. empty actionId returns 400 BAD_REQUEST", async () => {
    const { status, result } = await makeRequest({ actionId: "" });
    expect(status).toBe(400);
    expect(result.code).toBe("BAD_REQUEST");
  });

  it("3. actionId with only one segment returns 400 BAD_REQUEST", async () => {
    const { status, result } = await makeRequest({ actionId: "navigate" });
    expect(status).toBe(400);
    expect(result.code).toBe("BAD_REQUEST");
  });

  it("4. confirmation gate - start-job:service without confirmed returns 400 CONFIRM_REQUIRED", async () => {
    const { status, result } = await makeRequest({
      actionId: "start-job:service:newsbites:restart",
      reason: "test",
    });
    expect(status).toBe(400);
    expect(result.code).toBe("CONFIRM_REQUIRED");
  });

  it("5. reason gate - start-job:service without reason returns 400 REASON_REQUIRED", async () => {
    const { status, result } = await makeRequest({
      actionId: "start-job:service:newsbites:restart",
      confirmed: true,
    });
    expect(status).toBe(400);
    expect(result.code).toBe("REASON_REQUIRED");
  });

  it("6. allowlist gate - start-job:service with non-allowlisted service returns 400 ALLOWLIST", async () => {
    const { status, result } = await makeRequest({
      actionId: "start-job:service:random-svc:restart",
      confirmed: true,
      reason: "test",
    });
    expect(status).toBe(400);
    expect(result.code).toBe("ALLOWLIST");
  });

  it("7. navigate - low-risk, no gate returns 200 with action navigate", async () => {
    const { status, result } = await makeRequest({
      actionId: "navigate:service:newsbites",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("navigate");
  });

  it("8. copy-command for systemd service returns systemctl command", async () => {
    const { status, result } = await makeRequest({
      actionId: "copy-command:service:newsbites",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("copy-command");
    expect(result.text).toContain("systemctl is-active newsbites");
  });

  it("9. copy-command for Docker container returns docker inspect command", async () => {
    const { status, result } = await makeRequest({
      actionId: "copy-command:service:openclaw_gateway",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("copy-command");
    expect(result.text).toContain("docker inspect");
  });

  it("clears model cooldown through the canonical low-risk A4 action id", async () => {
    writeFileSync(process.env.DASHBOARD_MODEL_COOLDOWNS_PATH!, JSON.stringify({
      "editorial-heavy": { expiresAt: 2000, reason: "rate-limit" },
      "other-model": { expiresAt: 3000, reason: "keep" },
    }));

    const { status, result } = await makeRequest({
      actionId: "clear-cooldown:model:editorial-heavy",
      reason: "test clear",
    });

    const cooldowns = JSON.parse(readFileSync(process.env.DASHBOARD_MODEL_COOLDOWNS_PATH!, "utf8")) as Record<string, unknown>;
    const audit = getDashboardDb()!.query("SELECT action_id, risk, result_status FROM action_audit WHERE action_id = ?")
      .get("clear-cooldown:model:editorial-heavy") as { action_id: string; risk: string; result_status: string } | null;

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("clear-cooldown");
    expect(cooldowns["editorial-heavy"]).toBeUndefined();
    expect(cooldowns["other-model"]).toBeTruthy();
    expect(audit).toEqual({
      action_id: "clear-cooldown:model:editorial-heavy",
      risk: "low",
      result_status: "success",
    });
  });

  it("rotates a gateway key through the governed medium-risk action path", async () => {
    const now = Date.now();
    getDashboardDb()!.query(`
      INSERT INTO gateway_keys
        (id, agent_id, name, key_hash, model_allowlist, daily_cap_usd, status, created_at, last_used_at, tenant_id, rotated_from_key_id, rotation_revoke_at)
      VALUES ('gk-exec-rotate', 'agent-a', 'exec key', 'exec-key-hash', 'model-a', 4.5, 'active', ?, NULL, 'mimule', NULL, NULL)
    `).run(now);

    const confirmGate = await makeRequest({
      actionId: "rotate:gateway-key:gk-exec-rotate",
      reason: "test rotation",
    });
    expect(confirmGate.status).toBe(400);
    expect(confirmGate.result.code).toBe("CONFIRM_REQUIRED");

    const reasonGate = await makeRequest({
      actionId: "rotate:gateway-key:gk-exec-rotate",
      confirmed: true,
    });
    expect(reasonGate.status).toBe(400);
    expect(reasonGate.result.code).toBe("REASON_REQUIRED");

    const { status, result } = await makeRequest({
      actionId: "rotate:gateway-key:gk-exec-rotate",
      confirmed: true,
      reason: "test rotation",
      params: { graceSeconds: 120 },
    });

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("rotate");
    expect(result.result.key).toStartWith("gwk_");
    expect(result.result.record.rotatedFromKeyId).toBe("gk-exec-rotate");
    expect(result.result.record.agentId).toBe("agent-a");
    expect(result.result.record.name).toBe("exec key");
    expect(result.result.record.modelAllowlist).toEqual(["model-a"]);
    expect(result.result.record.dailyCapUsd).toBe(4.5);
    expect(result.result.rotationRevokeAt).toBeGreaterThanOrEqual(now + 120_000);

    const audit = getDashboardDb()!.query(`
      SELECT action_id, risk, reason, result_status
      FROM action_audit
      WHERE action_id = ? AND result_status = 'success'
      ORDER BY id DESC
      LIMIT 1
    `).get("rotate:gateway-key:gk-exec-rotate") as { action_id: string; risk: string; reason: string; result_status: string } | null;
    expect(audit).toEqual({
      action_id: "rotate:gateway-key:gk-exec-rotate",
      risk: "medium",
      reason: "test rotation",
      result_status: "success",
    });
  });

  it("pins a configured gateway model through the governed low-risk action path", async () => {
    const confirmGate = await makeRequest({
      actionId: "pin:gateway-route:editorial-heavy",
      reason: "keep local tonight",
    });
    expect(confirmGate.status).toBe(400);
    expect(confirmGate.result.code).toBe("CONFIRM_REQUIRED");

    const reasonGate = await makeRequest({
      actionId: "pin:gateway-route:editorial-heavy",
      confirmed: true,
    });
    expect(reasonGate.status).toBe(400);
    expect(reasonGate.result.code).toBe("REASON_REQUIRED");

    const unknown = await makeRequest({
      actionId: "pin:gateway-route:unknown-model",
      confirmed: true,
      reason: "test unknown model",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.result.code).toBe("NOT_FOUND");

    const startedAt = Date.now();
    const { status, result } = await makeRequest({
      actionId: "pin:gateway-route:editorial-heavy",
      confirmed: true,
      reason: "keep local tonight",
    });

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("pin");
    expect(result.message).toContain("Pinned gateway routing to editorial-heavy until");
    expect(getGatewayRoutePlanForGatewayAdmin("editorial-fast")[0]).toBe("editorial-heavy");
    expect(Date.parse(getGatewayRouteOverrideForGatewayAdmin()!.expiresAt) - startedAt).toBeGreaterThanOrEqual(14_400_000);

    const audit = getDashboardDb()!.query(`
      SELECT action_id, risk, reason, result_status
      FROM action_audit
      WHERE action_id = ? AND result_status = 'success'
      ORDER BY id DESC
      LIMIT 1
    `).get("pin:gateway-route:editorial-heavy") as { action_id: string; risk: string; reason: string; result_status: string } | null;
    expect(audit).toEqual({
      action_id: "pin:gateway-route:editorial-heavy",
      risk: "low",
      reason: "keep local tonight",
      result_status: "success",
    });
  });

  it("10. external-link for article returns article URL", async () => {
    const { status, result } = await makeRequest({
      actionId: "external-link:article:some-slug",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("external-link");
    expect(result.url).toContain("some-slug");
  });

  it("governs regen confirmation/reason and rejects unknown suffixes or missing dossiers", async () => {
    const confirmGate = await makeRequest({
      actionId: "regen:article:story-one:digest",
      reason: "refresh digest",
    });
    expect(confirmGate.status).toBe(400);
    expect(confirmGate.result.code).toBe("CONFIRM_REQUIRED");

    const reasonGate = await makeRequest({
      actionId: "regen:article:story-one:digest",
      confirmed: true,
    });
    expect(reasonGate.status).toBe(400);
    expect(reasonGate.result.code).toBe("REASON_REQUIRED");

    const unknown = await makeRequest({
      actionId: "regen:article:story-one:other",
      confirmed: true,
      reason: "test invalid suffix",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.result.code).toBe("BAD_REQUEST");

    const missing = await makeRequest({
      actionId: "regen:article:story-one:digest",
      confirmed: true,
      reason: "test missing dossier",
    });
    expect(missing.status).toBe(404);
    expect(missing.result.code).toBe("NOT_FOUND");
    expect(missing.result.error).toContain("regen needs the editorial dossier");
  });

  it("injects digest and image regen at their governed pipeline stages with audit rows", async () => {
    const older = join(process.env.DASHBOARD_DOSSIERS_ROOT!, "2026-06-01", "story-one");
    const newest = join(process.env.DASHBOARD_DOSSIERS_ROOT!, "2026-07-10", "story-one");
    mkdirSync(older, { recursive: true });
    mkdirSync(newest, { recursive: true });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, message: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }) as unknown as typeof fetch;

    for (const [artifact, stage] of [["digest", "publish-prep"], ["image", "fetch-image"]] as const) {
      const actionId = `regen:article:story-one:${artifact}`;
      const { status, result } = await makeRequest({ actionId, confirmed: true, reason: `refresh ${artifact}` });
      expect(status).toBe(200);
      expect(result.action).toBe("regen");
      const payload = JSON.parse(String(calls.at(-1)?.init?.body));
      expect(calls.at(-1)?.url).toBe("http://127.0.0.1:3200/command");
      expect(payload).toEqual({ cmd: "inject", dossierDir: newest, stage, slug: "story-one" });
      const audit = getDashboardDb()!.query("SELECT risk, result_status FROM action_audit WHERE action_id = ? ORDER BY id DESC LIMIT 1")
        .get(actionId) as { risk: string; result_status: string };
      expect(audit).toEqual({ risk: "medium", result_status: "success" });
    }
  });

  it("validates dossier stage retry targets and reports missing dossiers", async () => {
    for (const actionId of [
      "start-job:dossier:20260710/story-one:inject:write",
      "start-job:dossier:2026-07-10/Story_One:inject:write",
      "start-job:dossier:2026-07-10/story-one:inject:not-a-stage",
    ]) {
      const response = await makeRequest({ actionId, confirmed: true, reason: "test validation" });
      expect(response.status).toBe(400);
      expect(response.result.code).toBe("BAD_REQUEST");
    }

    const missing = await makeRequest({
      actionId: "start-job:dossier:2026-07-10/story-one:inject:write",
      confirmed: true,
      reason: "retry write",
    });
    expect(missing.status).toBe(404);
    expect(missing.result.code).toBe("NOT_FOUND");
  });

  it("injects a governed dossier stage retry with the requested stage and audit row", async () => {
    const dossierDir = join(process.env.DASHBOARD_DOSSIERS_ROOT!, "2026-07-10", "story-one");
    mkdirSync(dossierDir, { recursive: true });
    let pipelineBody: Record<string, string> | null = null;
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      pipelineBody = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, message: "retry queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }) as unknown as typeof fetch;
    const actionId = "start-job:dossier:2026-07-10/story-one:inject:validate-write";
    const { status, result } = await makeRequest({ actionId, confirmed: true, reason: "retry validation" });

    expect(status).toBe(200);
    expect(result.action).toBe("start-job");
    expect(result.message).toContain("validate-write");
    expect(pipelineBody).toEqual({ cmd: "inject", dossierDir, stage: "validate-write", slug: "story-one" });
    const audit = getDashboardDb()!.query("SELECT risk, result_status FROM action_audit WHERE action_id = ? ORDER BY id DESC LIMIT 1")
      .get(actionId) as { risk: string; result_status: string };
    expect(audit).toEqual({ risk: "medium", result_status: "success" });
  });

  it("11. incident acknowledge persists lifecycle fields", async () => {
    seedIncident("incident-ack");

    const { status, result } = await makeRequest({
      actionId: "acknowledge:incident:incident-ack",
    });

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("acknowledge");

    const row = getDashboardDb()!.query(`
      SELECT acknowledged_at, acknowledged_by
      FROM reasoner_incidents
      WHERE id = ?
    `).get("incident-ack") as { acknowledged_at: number | null; acknowledged_by: string | null };
    expect(row.acknowledged_at).toBeGreaterThan(0);
    expect(row.acknowledged_by).toBe("operator");
  });

  it("12. incident mitigate persists lifecycle fields", async () => {
    seedIncident("incident-mitigate");

    const { status, result } = await makeRequest({
      actionId: "mitigate:incident:incident-mitigate",
      confirmed: true,
      reason: "test mitigation",
    });

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("mitigate");

    const row = getDashboardDb()!.query(`
      SELECT mitigated_at, mitigated_by
      FROM reasoner_incidents
      WHERE id = ?
    `).get("incident-mitigate") as { mitigated_at: number | null; mitigated_by: string | null };
    expect(row.mitigated_at).toBeGreaterThan(0);
    expect(row.mitigated_by).toBe("operator");
  });

  it("13. mutate-policy with invalid suffix returns 400 BAD_REQUEST", async () => {
    const { status, result } = await makeRequest({
      actionId: "mutate-policy:model:editorial-heavy:delete",
      confirmed: true,
      reason: "test",
    });
    expect(status).toBe(400);
    expect(result.code).toBe("BAD_REQUEST");
  });

  it("14. unsupported kind returns 404 NOT_FOUND", async () => {
    const { status, result } = await makeRequest({
      actionId: "teleport:unknown:somewhere",
    });
    expect(status).toBe(404);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
  });

  it("15. project budget cap action persists project scope and audit", async () => {
    const { status, result } = await makeRequest({
      actionId: "mutate-policy:budget:project:project-alpha:set-cap",
      confirmed: true,
      reason: "project budget test",
      params: { dailyCapUsd: 3, monthlyCapUsd: 30, warnPct: 0.75 },
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.result.budget.scope).toBe("project");
    expect(result.result.budget.project_id).toBe("project-alpha");
    expect(result.result.budget.warn_pct).toBe(0.75);

    const row = getDashboardDb()!.query(`
      SELECT scope, project_id, daily_cap_usd, monthly_cap_usd, warn_pct
      FROM governance_budgets
      WHERE scope = 'project' AND project_id = ?
    `).get("project-alpha") as {
      scope: string;
      project_id: string;
      daily_cap_usd: number;
      monthly_cap_usd: number;
      warn_pct: number;
    } | null;
    expect(row?.daily_cap_usd).toBe(3);
    expect(row?.monthly_cap_usd).toBe(30);
    expect(row?.warn_pct).toBe(0.75);

    const audit = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM action_audit
      WHERE action_id = ?
        AND result_status = 'success'
    `).get("mutate-policy:budget:project:project-alpha:set-cap") as { count: number };
    expect(audit.count).toBe(1);
  });

  it("16. global budget cap action persists global scope and audit", async () => {
    const { status, result } = await makeRequest({
      actionId: "mutate-policy:budget:global:set-cap",
      confirmed: true,
      reason: "global budget test",
      params: { dailyCapUsd: 5, monthlyCapUsd: 50, warnPct: 0.8 },
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.result.budget.scope).toBe("global");
    expect(result.result.budget.project_id).toBeNull();
    expect(result.result.budget.warn_pct).toBe(0.8);

    const row = getDashboardDb()!.query(`
      SELECT scope, project_id, daily_cap_usd, monthly_cap_usd, warn_pct
      FROM governance_budgets
      WHERE scope = 'global'
    `).get() as {
      scope: string;
      project_id: string | null;
      daily_cap_usd: number;
      monthly_cap_usd: number;
      warn_pct: number;
    } | null;
    expect(row?.daily_cap_usd).toBe(5);
    expect(row?.monthly_cap_usd).toBe(50);
    expect(row?.warn_pct).toBe(0.8);

    const audit = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM action_audit
      WHERE action_id = ?
        AND result_status = 'success'
    `).get("mutate-policy:budget:global:set-cap") as { count: number };
    expect(audit.count).toBe(1);
  });
});
