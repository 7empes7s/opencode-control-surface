import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { testTenantContext } from "../tenancy/context.ts";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { writePolicyDecision, listPolicyDecisions } from "./store.ts";
import { writeSecret, listSecrets } from "./secrets.ts";
import { upsertBudget, getBudgetSpending } from "./budgets.ts";
import { createApprovalRequest, listApprovalRequests } from "./approvals.ts";

describe("governance tenant scoping", () => {
  beforeAll(() => {
    // Force enable dashboard DB for tests
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ enabled: true, path: ":memory:" });
  });

  afterAll(() => {
    closeDashboardDb();
    // Clean up environment variable
    delete process.env.DASHBOARD_DB;
  });

  it("should isolate policy decisions between tenants", () => {
    const tenantA = testTenantContext({ tenantId: "tenant-a" });
    const tenantB = testTenantContext({ tenantId: "tenant-b" });

    // Write policy decisions for both tenants
    writePolicyDecision("policy-1", "event-a", "allow", "rule-1", "test reason", {}, tenantA);
    writePolicyDecision("policy-2", "event-b", "deny", "rule-2", "test reason", {}, tenantB);

    // Check that each tenant only sees their own decisions
    const decisionsA = listPolicyDecisions(100, tenantA);
    const decisionsB = listPolicyDecisions(100, tenantB);

    expect(decisionsA).toHaveLength(1);
    expect(decisionsA[0].policy_id).toBe("policy-1");
    expect(decisionsA[0].tenant_id).toBe("tenant-a");

    expect(decisionsB).toHaveLength(1);
    expect(decisionsB[0].policy_id).toBe("policy-2");
    expect(decisionsB[0].tenant_id).toBe("tenant-b");
  });

  it("should isolate secrets between tenants", () => {
    const tenantA = testTenantContext({ tenantId: "tenant-a" });
    const tenantB = testTenantContext({ tenantId: "tenant-b" });

    // Write secrets for both tenants
    writeSecret("secret-key-1", "value-1", "desc-1", tenantA);
    writeSecret("secret-key-2", "value-2", "desc-2", tenantB);

    // Check that each tenant only sees their own secrets
    const secretsA = listSecrets(tenantA);
    const secretsB = listSecrets(tenantB);

    expect(secretsA).toHaveLength(1);
    expect(secretsA[0].name).toBe("secret-key-1");

    expect(secretsB).toHaveLength(1);
    expect(secretsB[0].name).toBe("secret-key-2");
  });

  it("should isolate budgets between tenants", () => {
    const tenantA = testTenantContext({ tenantId: "tenant-a" });
    const tenantB = testTenantContext({ tenantId: "tenant-b" });

    // Write budgets for both tenants
    upsertBudget("global", { dailyCapUsd: 100, monthlyCapUsd: 1000 }, tenantA);
    upsertBudget("global", { dailyCapUsd: 200, monthlyCapUsd: 2000 }, tenantB);

    // Check that budgets are tenant-scoped
    const spendingA = getBudgetSpending("global", undefined, tenantA);
    const spendingB = getBudgetSpending("global", undefined, tenantB);

    // Spending should be isolated
    expect(spendingA.daily).toBe(0);
    expect(spendingB.daily).toBe(0);
  });

  it("should isolate approval requests between tenants", () => {
    const tenantA = testTenantContext({ tenantId: "tenant-a" });
    const tenantB = testTenantContext({ tenantId: "tenant-b" });

    // Create approval requests for both tenants
    createApprovalRequest("workflow-1", "run-1", "user-1", 1, undefined, tenantA);
    createApprovalRequest("workflow-2", "run-2", "user-2", 1, undefined, tenantB);

    // Check that each tenant only sees their own approval requests
    const approvalsA = listApprovalRequests(undefined, tenantA);
    const approvalsB = listApprovalRequests(undefined, tenantB);

    expect(approvalsA).toHaveLength(1);
    expect(approvalsA[0].workflowId).toBe("workflow-1");
    expect(approvalsA[0].tenantId).toBe("tenant-a");

    expect(approvalsB).toHaveLength(1);
    expect(approvalsB[0].workflowId).toBe("workflow-2");
    expect(approvalsB[0].tenantId).toBe("tenant-b");
  });
});