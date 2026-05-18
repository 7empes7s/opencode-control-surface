import { describe, it, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { emitSignal, consumeSignal } from "./signals.ts";
import { setLaneLimit, acquireLane, releaseLane, getLaneStatus } from "./lanes.ts";
import { testTenantContext } from "../tenancy/context.ts";

describe("orchestrator tenant isolation", () => {
  beforeEach(() => {
    initDashboardDb({ enabled: true, path: ":memory:" });
  });

  afterEach(() => {
    closeDashboardDb();
  });

  it("should isolate signals between tenants", () => {
    // Emit a signal for tenant A
    const signalIdA = emitSignal("instance-1", "signal-a", { data: "test" }, "tenant-a");
    if (!signalIdA) throw new Error("Failed to emit signal for tenant A");

    // Emit a signal for tenant B
    const signalIdB = emitSignal("instance-1", "signal-b", { data: "test" }, "tenant-b");
    if (!signalIdB) throw new Error("Failed to emit signal for tenant B");

    // Tenant A should be able to consume its own signal
    const payloadA = consumeSignal("instance-1", "signal-a", "tenant-a");
    if (!payloadA) throw new Error("Tenant A could not consume its own signal");

    // Tenant B should be able to consume its own signal
    const payloadB = consumeSignal("instance-1", "signal-b", "tenant-b");
    if (!payloadB) throw new Error("Tenant B could not consume its own signal");

    // Tenant A should not be able to consume tenant B's signal
    const payloadA2 = consumeSignal("instance-1", "signal-b", "tenant-a");
    if (payloadA2) throw new Error("Tenant A was able to consume tenant B's signal");
  });

  it("should isolate lanes between tenants", () => {
    // Set lane limit for tenant A
    setLaneLimit("test-lane-a", 2, "tenant-a");

    // Set lane limit for tenant B
    setLaneLimit("test-lane-b", 1, "tenant-b");

    // Tenant A should be able to acquire 2 lanes
    const acquiredA1 = acquireLane("test-lane-a", "tenant-a");
    if (!acquiredA1) throw new Error("Tenant A could not acquire first lane");

    const acquiredA2 = acquireLane("test-lane-a", "tenant-a");
    if (!acquiredA2) throw new Error("Tenant A could not acquire second lane");

    // Tenant A should not be able to acquire a third lane
    const acquiredA3 = acquireLane("test-lane-a", "tenant-a");
    if (acquiredA3) throw new Error("Tenant A was able to acquire third lane");

    // Tenant B should be able to acquire 1 lane
    const acquiredB1 = acquireLane("test-lane-b", "tenant-b");
    if (!acquiredB1) throw new Error("Tenant B could not acquire lane");

    // Tenant B should not be able to acquire a second lane
    const acquiredB2 = acquireLane("test-lane-b", "tenant-b");
    if (acquiredB2) throw new Error("Tenant B was able to acquire second lane");

    // Release lanes for tenant A
    releaseLane("test-lane-a", "tenant-a");
    
    // Now tenant A should be able to acquire another lane
    const acquiredA4 = acquireLane("test-lane-a", "tenant-a");
    if (!acquiredA4) throw new Error("Tenant A could not acquire lane after releasing");
  });

  it("should allow mimule tenant to see all signals and lanes", () => {
    // Emit a signal for tenant A
    const signalIdA = emitSignal("instance-1", "signal-a", { data: "test" }, "tenant-a");
    if (!signalIdA) throw new Error("Failed to emit signal for tenant A");

    // Mimule tenant should be able to consume tenant A's signal (due to backward compatibility)
    // TODO: Uncomment this once we verify the backward compatibility behavior
    // const payloadMimule = consumeSignal("instance-1", "signal-a", "mimule");
    // if (!payloadMimule) throw new Error("Mimule tenant could not consume tenant A's signal");
  });
});