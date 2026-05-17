import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { seedPlaybooks, listPlaybooks, matchPlaybook } from "./playbooks.ts";

describe("playbooks", () => {
  const testDbPath = `/tmp/test-playbooks-${Date.now()}.sqlite`;

  beforeAll(() => {
    initDashboardDb({ enabled: true, path: testDbPath });
  });

  afterAll(() => {
    closeDashboardDb();
  });

  beforeEach(() => {
    const db = getDashboardDb()!;
    db.query("DELETE FROM reasoner_playbooks").run();
    db.query("DELETE FROM reasoner_playbook_runs").run();
  });

  test("seedPlaybooks inserts 5 built-in playbooks", () => {
    const db = getDashboardDb()!;
    seedPlaybooks(db);
    const playbooks = listPlaybooks(db);
    expect(playbooks).toHaveLength(5);
  });

  test("seedPlaybooks is idempotent — calling twice keeps 5 rows", () => {
    const db = getDashboardDb()!;
    seedPlaybooks(db);
    seedPlaybooks(db);
    const playbooks = listPlaybooks(db);
    expect(playbooks).toHaveLength(5);
  });

  test("matchPlaybook returns correct entry for exact failure class", () => {
    const db = getDashboardDb()!;
    seedPlaybooks(db);
    const match = matchPlaybook(db, "codex-exhausted");
    expect(match).not.toBeNull();
    expect(match!.id).toBe("codex-exhausted");
    expect(match!.actions).toContain("switch-agent-opencode");
    expect(match!.isSafe).toBe(true);
  });

  test("matchPlaybook returns null for unknown failure class", () => {
    const db = getDashboardDb()!;
    seedPlaybooks(db);
    const match = matchPlaybook(db, "unknown-failure-class");
    expect(match).toBeNull();
  });

  test("matchPlaybook returns the non-safe playbook for validation-failed", () => {
    const db = getDashboardDb()!;
    seedPlaybooks(db);
    const match = matchPlaybook(db, "validation-failed");
    expect(match).not.toBeNull();
    expect(match!.isSafe).toBe(false);
    expect(match!.actions).toContain("notify-operator");
  });

  test("matchPlaybook uses glob pattern — wildcard '*' matches any class", () => {
    const db = getDashboardDb()!;
    db.query(`
      INSERT INTO reasoner_playbooks
        (id, name, description, failure_class_pattern, actions_json, is_safe, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("wildcard-catch", "Catch-all", "Matches all", "*", '["notify-operator"]', 0, Date.now());
    const match = matchPlaybook(db, "some-random-failure");
    expect(match).not.toBeNull();
    expect(match!.id).toBe("wildcard-catch");
  });
});
