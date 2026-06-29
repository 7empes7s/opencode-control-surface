import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { executeActionHandler } from "./execute.ts";

describe("executeActionHandler", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "execute-api-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
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

  it("10. external-link for article returns article URL", async () => {
    const { status, result } = await makeRequest({
      actionId: "external-link:article:some-slug",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("external-link");
    expect(result.url).toContain("some-slug");
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
});
