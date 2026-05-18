import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
  submitVote,
  expireStaleRequests,
} from "../governance/approvals.ts";
import { initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "approvals-test-"));
const TEST_DB = join(TEST_DIR, "approvals.sqlite");

describe("approvals", () => {
  beforeAll(() => {
    initDashboardDb({ enabled: true, path: TEST_DB });
  });

  afterAll(() => {
    closeDashboardDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("createApprovalRequest", () => {
    it("creates a pending approval request", () => {
      const req = createApprovalRequest("wf1", "run1", "alice", 2);
      expect(req.status).toBe("pending");
      expect(req.workflowId).toBe("wf1");
      expect(req.runId).toBe("run1");
      expect(req.requiredCount).toBe(2);
      expect(req.approvals).toEqual([]);
    });

    it("sets expiry time when provided", () => {
      const future = Date.now() + 3600 * 1000;
      const req = createApprovalRequest("wf1", "run1", "alice", 2, future);
      expect(req.expiresAt).toBe(future);
    });
  });

  describe("submitVote", () => {
    it("vote once keeps status pending when requiredCount > 1", () => {
      const req = createApprovalRequest("wf1", "run1", "alice", 2);
      const updated = submitVote(req.id, "bob", "approve");
      expect(updated?.status).toBe("pending");
    });

    it("two different voters with approve transitions to approved", () => {
      const req = createApprovalRequest("wf1", "run1", "alice", 2);
      submitVote(req.id, "bob", "approve");
      const updated = submitVote(req.id, "carol", "approve");
      expect(updated?.status).toBe("approved");
    });

    it("same voter twice is deduplicated — still pending", () => {
      const req = createApprovalRequest("wf1", "run1", "alice", 2);
      submitVote(req.id, "bob", "approve");
      const updated = submitVote(req.id, "bob", "approve");
      expect(updated?.status).toBe("pending");
    });

    it("reject transitions to rejected immediately", () => {
      const req = createApprovalRequest("wf1", "run1", "alice", 2);
      const updated = submitVote(req.id, "bob", "reject");
      expect(updated?.status).toBe("rejected");
    });

    it("any reject wins even after approvals", () => {
      const req = createApprovalRequest("wf1", "run1", "alice", 3);
      submitVote(req.id, "bob", "approve");
      submitVote(req.id, "carol", "approve");
      const updated = submitVote(req.id, "dave", "reject");
      expect(updated?.status).toBe("rejected");
    });
  });

  describe("expireStaleRequests", () => {
    it("marks expired requests as expired", () => {
      const req = createApprovalRequest("wf1", "run1", "alice", 2, Date.now() - 1000);
      expireStaleRequests();
      const updated = getApprovalRequest(req.id);
      expect(updated?.status).toBe("expired");
    });

    it("does not expire requests with future expiry", () => {
      const req = createApprovalRequest("wf1", "run1", "alice", 2, Date.now() + 3600 * 1000);
      expireStaleRequests();
      const updated = getApprovalRequest(req.id);
      expect(updated?.status).toBe("pending");
    });
  });

  describe("listApprovalRequests", () => {
    it("lists pending requests for tenant", () => {
      createApprovalRequest("wf1", "run1", "alice", 2);
      createApprovalRequest("wf2", "run2", "alice", 2);
      createApprovalRequest("wf3", "run3", "alice", 2);
      const pending = listApprovalRequests("pending");
      expect(pending.filter((r) => r.status === "pending").length).toBeGreaterThanOrEqual(3);
    });
  });
});
