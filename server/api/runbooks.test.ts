import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildActionCatalog } from "./actionDescriptors.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { DISCOVERY_SOURCES, type DiscoveredAssetInput } from "../discovery/reconcile.ts";
import { _resetGatewayConfigCacheForTests } from "../gateway/config.ts";
import { setRunbookCatalogProviderForTests } from "../runbooks/engine.ts";
import {
  runbooksListHandler,
  runbookArchiveHandler,
  runbookCreateHandler,
  runbookRunGetHandler,
  runbookRunsHandler,
  runbookStartHandler,
  runbookUpdateHandler,
} from "./runbooks.ts";

type Json = Record<string, any>;
type RunStepRow = { status: string; started_at: number; finished_at: number };

describe("runbooks API", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;
  let previousGatewayConfig: string | undefined;
  let previousDossiersRoot: string | undefined;
  let originalDiscoveryProbe: typeof DISCOVERY_SOURCES["proc-cmdline"];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "runbooks-api-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    previousGatewayConfig = process.env.GATEWAY_CONFIG;
    previousDossiersRoot = process.env.DASHBOARD_DOSSIERS_ROOT;
    originalFetch = globalThis.fetch;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    process.env.GATEWAY_CONFIG = join(tempDir, "gateway.yaml");
    process.env.DASHBOARD_DOSSIERS_ROOT = join(tempDir, "empty-dossiers");
    mkdirSync(process.env.DASHBOARD_DOSSIERS_ROOT, { recursive: true });
    writeFileSync(process.env.GATEWAY_CONFIG, "version: 1\nmodels: {}\n");
    globalThis.fetch = (() => Promise.reject(new Error("network disabled in runbook tests"))) as unknown as typeof fetch;
    _resetGatewayConfigCacheForTests();
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });

    originalDiscoveryProbe = DISCOVERY_SOURCES["proc-cmdline"];
    DISCOVERY_SOURCES["proc-cmdline"] = () => [{
      kind: "process",
      signature: "hermetic runbook process",
      sourceProbe: "proc-cmdline",
      fingerprint: { pid: 1 },
    } satisfies DiscoveredAssetInput];
    setRunbookCatalogProviderForTests(() => buildActionCatalog({}));
  });

  afterEach(() => {
    DISCOVERY_SOURCES["proc-cmdline"] = originalDiscoveryProbe;
    setRunbookCatalogProviderForTests();
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    if (previousGatewayConfig === undefined) delete process.env.GATEWAY_CONFIG;
    else process.env.GATEWAY_CONFIG = previousGatewayConfig;
    if (previousDossiersRoot === undefined) delete process.env.DASHBOARD_DOSSIERS_ROOT;
    else process.env.DASHBOARD_DOSSIERS_ROOT = previousDossiersRoot;
    globalThis.fetch = originalFetch;
    _resetGatewayConfigCacheForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function request(path: string, body?: unknown, method = "POST"): Request {
    return new Request(`http://runbooks.test${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function body(response: Response): Promise<Json> {
    return await response.json() as Json;
  }

  async function createRunbook(steps: Array<{ actionId: string; params?: Record<string, unknown> }> = [{ actionId: "scan:discovery:proc-cmdline" }]) {
    const response = await runbookCreateHandler(request("/api/runbooks", {
      name: "Discovery refresh",
      description: "Refresh discovery safely",
      steps,
    }));
    const json = await body(response);
    expect(response.status).toBe(201);
    return json.data.id as string;
  }

  async function waitForRun(runId: string): Promise<Json> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = runbookRunGetHandler(runId);
      const json = await body(response);
      if (json.data.run.status !== "running") return json.data;
      await Bun.sleep(5);
    }
    throw new Error(`run ${runId} did not finish`);
  }

  it("creates, lists, updates, and archives definitions", async () => {
    const id = await createRunbook();
    const listed = await body(runbooksListHandler());
    expect(listed.data.runbooks).toHaveLength(1);
    expect(listed.data.runbooks[0]).toMatchObject({
      id,
      name: "Discovery refresh",
      description: "Refresh discovery safely",
      stepCount: 1,
      risk: "medium",
      lastRun: null,
    });

    const updatedResponse = await runbookUpdateHandler(request(`/api/runbooks/${id}`, {
      name: "Discovery refresh twice",
      description: "Two ordered scans",
      steps: [
        { actionId: "scan:discovery:proc-cmdline" },
        { actionId: "scan:discovery:proc-cmdline", params: { source: "test" } },
      ],
    }, "PUT"), id);
    expect(updatedResponse.status).toBe(200);
    const updated = await body(runbooksListHandler());
    expect(updated.data.runbooks[0]).toMatchObject({ name: "Discovery refresh twice", stepCount: 2 });

    const updateAudit = getDashboardDb()!.query(`
      SELECT request_json FROM action_audit WHERE action_kind = 'runbook.update' ORDER BY id DESC LIMIT 1
    `).get() as { request_json: string };
    expect(JSON.parse(updateAudit.request_json)).toMatchObject({ beforeStepCount: 1, afterStepCount: 2 });

    expect(runbookArchiveHandler(id).status).toBe(200);
    expect((await body(runbooksListHandler())).data.runbooks).toEqual([]);
    const archivedRun = await runbookStartHandler(request(`/api/runbooks/${id}/run`, {
      confirmed: true,
      reason: "must not run archived definition",
    }), id);
    expect(archivedRun.status).toBe(409);
    expect((await body(archivedRun)).code).toBe("ARCHIVED");
  });

  it("rejects empty, oversized, unknown-catalog, and malformed steps", async () => {
    const cases = [
      [],
      Array.from({ length: 21 }, () => ({ actionId: "scan:discovery:proc-cmdline" })),
      [{ actionId: "scan:discovery:not-in-catalog" }],
      [{ actionId: "garbage" }],
    ];
    for (const steps of cases) {
      const response = await runbookCreateHandler(request("/api/runbooks", { name: "Invalid", steps }));
      expect(response.status).toBe(400);
      expect((await body(response)).code).toBe("BAD_REQUEST");
    }
  });

  it("floors low-only bundles at medium and takes the maximum catalog risk", async () => {
    const mediumId = await createRunbook();
    expect((await body(runbooksListHandler())).data.runbooks.find((runbook: Json) => runbook.id === mediumId).risk).toBe("medium");

    setRunbookCatalogProviderForTests(() => buildActionCatalog({
      services: [{ name: "control-surface", status: "active" }],
    }));
    const highId = await createRunbook([{ actionId: "start-job:service:control-surface" }]);
    expect((await body(runbooksListHandler())).data.runbooks.find((runbook: Json) => runbook.id === highId).risk).toBe("high");
  });

  it("returns 404 for unknown definition and run ids", async () => {
    const update = await runbookUpdateHandler(request("/api/runbooks/missing", {
      name: "Missing",
      steps: [{ actionId: "scan:discovery:proc-cmdline" }],
    }, "PUT"), "missing");
    expect(update.status).toBe(404);
    expect(runbookArchiveHandler("missing").status).toBe(404);
    expect((await runbookStartHandler(request("/api/runbooks/missing/run", { confirmed: true, reason: "test" }), "missing")).status).toBe(404);
    expect(runbookRunGetHandler("missing").status).toBe(404);
    expect(runbookRunsHandler("missing", new URL("http://x/api/runbooks/missing/runs")).status).toBe(404);
  });

  it("audits confirmation and reason enforcement failures", async () => {
    const id = await createRunbook();
    const noConfirm = await runbookStartHandler(request(`/api/runbooks/${id}/run`, { reason: "test" }), id);
    expect(noConfirm.status).toBe(400);
    expect((await body(noConfirm)).code).toBe("CONFIRM_REQUIRED");
    const noReason = await runbookStartHandler(request(`/api/runbooks/${id}/run`, { confirmed: true }), id);
    expect(noReason.status).toBe(400);
    expect((await body(noReason)).code).toBe("REASON_REQUIRED");
    const audits = getDashboardDb()!.query(`
      SELECT result_status, error FROM action_audit
      WHERE action_kind = 'runbook.run' AND target_id = ? ORDER BY id
    `).all(id) as Array<{ result_status: string; error: string }>;
    expect(audits).toEqual([
      { result_status: "failed", error: "confirmation required" },
      { result_status: "failed", error: "reason required" },
    ]);
  });

  it("runs safe catalog actions sequentially and correlates step and run audits", async () => {
    const id = await createRunbook([
      { actionId: "scan:discovery:proc-cmdline" },
      { actionId: "scan:discovery:proc-cmdline", params: { pass: 2 } },
    ]);
    const response = await runbookStartHandler(request(`/api/runbooks/${id}/run`, {
      confirmed: true,
      reason: "hermetic sequential run",
    }), id);
    const started = await body(response);
    expect(response.status).toBe(202);
    expect(started).toEqual({
      runId: expect.any(String),
      status: "running",
      pollUrl: `/api/runbooks/runs/${started.runId}`,
    });

    const completed = await waitForRun(started.runId);
    expect(completed.run).toMatchObject({ runbook_id: id, status: "success", risk: "medium", error: null });
    expect(completed.steps.map((step: RunStepRow) => step.status)).toEqual(["success", "success"]);
    expect(completed.steps[0].started_at).toBeLessThanOrEqual(completed.steps[0].finished_at);
    expect(completed.steps[0].finished_at).toBeLessThanOrEqual(completed.steps[1].started_at);

    const stepAudits = getDashboardDb()!.query(`
      SELECT request_json, result_status FROM action_audit
      WHERE action_id = 'scan:discovery:proc-cmdline' ORDER BY id
    `).all() as Array<{ request_json: string; result_status: string }>;
    expect(stepAudits).toHaveLength(2);
    expect(stepAudits.every((audit) => JSON.parse(audit.request_json).runbookRunId === started.runId)).toBe(true);
    expect(stepAudits.every((audit) => audit.result_status === "success")).toBe(true);

    const runAudit = getDashboardDb()!.query(`
      SELECT result_status, result_json FROM action_audit
      WHERE action_kind = 'runbook.run' AND target_id = ? ORDER BY id DESC LIMIT 1
    `).get(id) as { result_status: string; result_json: string };
    expect(runAudit.result_status).toBe("success");
    expect(JSON.parse(runAudit.result_json)).toMatchObject({
      runId: started.runId,
      steps: [{ status: "success" }, { status: "success" }],
    });

    const history = await body(runbookRunsHandler(id, new URL(`http://x/api/runbooks/${id}/runs?limit=5`)));
    expect(history.data.runs).toHaveLength(1);
    expect(history.data.runs[0].id).toBe(started.runId);
  });

  it("fails on a real catalog action dispatch error and skips later steps", async () => {
    const article = { slug: "nonexistent-slug", title: "Missing dossier", status: "published", date: "2026-01-01", vertical: "tech", wordCount: 100 };
    setRunbookCatalogProviderForTests(() => buildActionCatalog({ articles: [article] }));
    const id = await createRunbook([
      { actionId: "regen:article:nonexistent-slug:digest" },
      { actionId: "scan:discovery:proc-cmdline" },
    ]);
    const response = await runbookStartHandler(request(`/api/runbooks/${id}/run`, {
      confirmed: true,
      reason: "exercise stop-on-failure",
    }), id);
    const started = await body(response);
    const completed = await waitForRun(started.runId);
    expect(completed.run.status).toBe("failed");
    expect(completed.run.error).toContain("no dossier found for article nonexistent-slug");
    expect(completed.steps.map((step: RunStepRow) => step.status)).toEqual(["failed", "skipped"]);

    const actionAudit = getDashboardDb()!.query(`
      SELECT result_status, request_json, error FROM action_audit
      WHERE action_id = 'regen:article:nonexistent-slug:digest' ORDER BY id DESC LIMIT 1
    `).get() as { result_status: string; request_json: string; error: string };
    expect(actionAudit.result_status).toBe("failed");
    expect(actionAudit.error).toContain("no dossier found");
    expect(JSON.parse(actionAudit.request_json).runbookRunId).toBe(started.runId);
  });

  it("revalidates stored steps when an action vanishes before run start", async () => {
    const id = await createRunbook();
    setRunbookCatalogProviderForTests(() => buildActionCatalog({}).filter((action) => action.id !== "scan:discovery:proc-cmdline"));
    const response = await runbookStartHandler(request(`/api/runbooks/${id}/run`, {
      confirmed: true,
      reason: "catalog changed",
    }), id);
    const json = await body(response);
    expect(response.status).toBe(400);
    expect(json.error).toContain("scan:discovery:proc-cmdline");
    expect(json.error).toContain("current action catalog");
  });
});
