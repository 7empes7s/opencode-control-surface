import { describe, it, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { initDashboardDb, closeDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { queueDiagnosis } from "./agent.ts";
import { testTenantContext } from "../tenancy/context.ts";

describe("reasoner tenant isolation", () => {
  beforeEach(() => {
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ enabled: true, path: ":memory:" });
  });

  afterEach(() => {
    closeDashboardDb();
  });

  it("should isolate reasoner jobs between tenants", () => {
    // Queue a job for tenant A
    const ctxA = testTenantContext({ tenantId: "tenant-a" });
    tenantStore.run(ctxA, () => {
      const jobId = queueDiagnosis("pass-1", "run-1", "workflow-1");
      if (!jobId) throw new Error("Failed to queue job for tenant A");
    });

    // Queue a job for tenant B
    const ctxB = testTenantContext({ tenantId: "tenant-b" });
    tenantStore.run(ctxB, () => {
      const jobId = queueDiagnosis("pass-2", "run-2", "workflow-2");
      if (!jobId) throw new Error("Failed to queue job for tenant B");
    });

    // Verify tenant A can only see its own job
    const ctxA2 = testTenantContext({ tenantId: "tenant-a" });
    // TODO: Add verification logic here once we have read functions
  });

  it("should allow mimule tenant to see all jobs", () => {
    // Queue a job for tenant A
    const ctxA = testTenantContext({ tenantId: "tenant-a" });
    tenantStore.run(ctxA, () => {
      const jobId = queueDiagnosis("pass-1", "run-1", "workflow-1");
      if (!jobId) throw new Error("Failed to queue job for tenant A");
    });

    // Mimule tenant should be able to see the job (due to backward compatibility)
    const ctxMimule = testTenantContext({ tenantId: "mimule" });
    // TODO: Add verification logic here once we have read functions
  });
});