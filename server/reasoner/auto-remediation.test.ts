import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { seedPlaybooks, matchPlaybook, applyPlaybookAction, recordPlaybookRun } from "./playbooks.ts";

describe("auto-remediation — codex-exhausted triggers switch-agent-opencode", () => {
  const testDbPath = `/tmp/test-auto-remediation-${Date.now()}.sqlite`;

  beforeAll(() => {
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ enabled: true, path: testDbPath });
  });

  afterAll(() => {
    closeDashboardDb();
  });

  beforeEach(() => {
    const db = getDashboardDb()!;
    db.query("DELETE FROM reasoner_playbooks").run();
    db.query("DELETE FROM reasoner_playbook_runs").run();
    db.query("DELETE FROM builder_workflows").run();
    db.query("DELETE FROM builder_projects").run();
  });

  function insertTestWorkflow(id: string, agentOrder: string[]) {
    const db = getDashboardDb()!;
    const projectId = `proj_test`;
    db.query(`INSERT OR IGNORE INTO builder_projects (id, root, created_at) VALUES (?, ?, ?)`).run(projectId, "/tmp/test", Date.now());
    const config = {
      projectRoot: "/tmp/test",
      agentOrder,
      modelPolicy: { fallbackTargets: [] },
      validationProfile: { commands: [], internal: [], runtime: [], public: [] },
      gitPolicy: { commit: "manual", push: "never" },
      backupPolicy: { enabled: false, beforeRun: false },
      riskPolicy: { liveDeploys: "disabled", maxPasses: 5 },
      autoApplySafePlaybooks: true,
    };
    db.query(`
      INSERT INTO builder_workflows
        (id, project_id, name, mode, status, plan_file, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, "Test Workflow", "single-pass", "ready", "/tmp/plan.md", JSON.stringify(config), Date.now(), Date.now());
  }

  test("matchPlaybook returns codex-exhausted playbook with isSafe=true and switch-agent-opencode action", () => {
    const db = getDashboardDb()!;
    seedPlaybooks(db);

    const playbook = matchPlaybook(db, "codex-exhausted");
    expect(playbook).not.toBeNull();
    expect(playbook!.isSafe).toBe(true);
    expect(playbook!.actions).toContain("switch-agent-opencode");
  });

  test("applyPlaybookAction switch-agent-opencode updates workflow agentOrder to put opencode first", async () => {
    const db = getDashboardDb()!;
    seedPlaybooks(db);
    const workflowId = "bw_test_auto";
    insertTestWorkflow(workflowId, ["codex", "claude"]);

    const result = await applyPlaybookAction("switch-agent-opencode", workflowId, null, null);
    expect(result).toBe("agent-order-updated");

    const row = db.query(`SELECT config_json FROM builder_workflows WHERE id = ?`).get(workflowId) as { config_json: string } | null;
    expect(row).not.toBeNull();
    const config = JSON.parse(row!.config_json) as { agentOrder: string[] };
    expect(config.agentOrder[0]).toBe("opencode");
  });

  test("recordPlaybookRun stores an auto-triggered run row", () => {
    const db = getDashboardDb()!;
    seedPlaybooks(db);

    const runId = recordPlaybookRun(db, "codex-exhausted", null, "pass_001", "auto", ["switch-agent-opencode"], "agent-order-updated");
    expect(runId.startsWith("rpr_")).toBe(true);

    const row = db.query(`SELECT * FROM reasoner_playbook_runs WHERE id = ?`).get(runId) as {
      triggered_by: string;
      playbook_id: string;
      result: string;
    } | null;
    expect(row).not.toBeNull();
    expect(row!.triggered_by).toBe("auto");
    expect(row!.playbook_id).toBe("codex-exhausted");
    expect(row!.result).toBe("agent-order-updated");
  });
});
