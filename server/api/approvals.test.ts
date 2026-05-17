import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, rmSync } from "node:fs";
import {
  createApprovalRequest,
  getApprovalRequest,
  submitVote,
  expireStaleRequests,
  listApprovalRequests,
} from "../governance/approvals.ts";
import { getDashboardDb, initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";

const TEST_DB = "/tmp/test-approvals-control-surface.db";

function setupTestDb(): Database {
  rmSync(TEST_DB, { force: true });
  mkdirSync("/tmp", { recursive: true });
  chmodSync("/tmp", 0o755);
  return initDashboardDb({ enabled: true, path: TEST_DB })!;
}

function createTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_approvals (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tenant_id TEXT,
      requested_at INTEGER NOT NULL,
      requested_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approvals_json TEXT NOT NULL DEFAULT '[]',
      required_count INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER,
      decided_at INTEGER,
      decided_by TEXT,
      decision TEXT,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS governance_approval_votes (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      voter TEXT NOT NULL,
      decision TEXT NOT NULL,
      comment TEXT,
      voted_at INTEGER NOT NULL
    );
  `);
}

function clearTables(db: Database): void {
  db.query("DELETE FROM governance_approval_votes").run();
  db.query("DELETE FROM governance_approvals").run();
}

describe("approvals", () => {
  let db: Database;

  beforeEach(() => {
    closeDashboardDb();
    process.env.DASHBOARD_DB = "1";
    db = setupTestDb();
    createTables(db);
    clearTables(db);
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });

  describe("createApprovalRequest", () => {
    it("creates a pending approval request", () => {
      const req = createApprovalRequest("wf1", "run1", "tenant1", "alice", 2);
      expect(req.status).toBe("pending");
      expect(req.workflowId).toBe("wf1");
      expect(req.runId).toBe("run1");
      expect(req.requiredCount).toBe(2);
      expect(req.approvals).toEqual([]);
    });

    it("sets expiry time when provided", () => {
      const future = Date.now() + 3600 * 1000;
      const req = createApprovalRequest("wf1", "run1", "tenant1", "alice", 2, future);
      expect(req.expiresAt).toBe(future);
    });
  });

  describe("submitVote", () => {
    it("vote once keeps status pending when requiredCount > 1", () => {
      const req = createApprovalRequest("wf1", "run1", "tenant1", "alice", 2);
      const updated = submitVote(req.id, "bob", "approve");
      expect(updated?.status).toBe("pending");
    });

    it("two different voters with approve transitions to approved", () => {
      const req = createApprovalRequest("wf1", "run1", "tenant1", "alice", 2);
      submitVote(req.id, "bob", "approve");
      const updated = submitVote(req.id, "carol", "approve");
      expect(updated?.status).toBe("approved");
    });

    it("same voter twice is deduplicated — still pending", () => {
      const req = createApprovalRequest("wf1", "run1", "tenant1", "alice", 2);
      submitVote(req.id, "bob", "approve");
      const updated = submitVote(req.id, "bob", "approve");
      expect(updated?.status).toBe("pending");
    });

    it("reject transitions to rejected immediately", () => {
      const req = createApprovalRequest("wf1", "run1", "tenant1", "alice", 2);
      const updated = submitVote(req.id, "bob", "reject");
      expect(updated?.status).toBe("rejected");
    });

    it("any reject wins even after approvals", () => {
      const req = createApprovalRequest("wf1", "run1", "tenant1", "alice", 3);
      submitVote(req.id, "bob", "approve");
      submitVote(req.id, "carol", "approve");
      const updated = submitVote(req.id, "dave", "reject");
      expect(updated?.status).toBe("rejected");
    });
  });

  describe("expireStaleRequests", () => {
    it("marks expired requests as expired", () => {
      const req = createApprovalRequest("wf1", "run1", "tenant1", "alice", 2, Date.now() - 1000);
      expireStaleRequests();
      const updated = getApprovalRequest(req.id);
      expect(updated?.status).toBe("expired");
    });

    it("does not expire requests with future expiry", () => {
      const req = createApprovalRequest("wf1", "run1", "tenant1", "alice", 2, Date.now() + 3600 * 1000);
      expireStaleRequests();
      const updated = getApprovalRequest(req.id);
      expect(updated?.status).toBe("pending");
    });
  });

  describe("listApprovalRequests", () => {
    it("lists pending requests for tenant", () => {
      createApprovalRequest("wf1", "run1", "tenant1", "alice", 2);
      createApprovalRequest("wf2", "run2", "tenant1", "alice", 2);
      createApprovalRequest("wf3", "run3", "tenant2", "alice", 2);
      const pending = listApprovalRequests("tenant1", "pending");
      expect(pending.filter((r) => r.tenantId === "tenant1").length).toBe(2);
    });
  });
});