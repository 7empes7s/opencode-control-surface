import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { emitSignal, consumeSignal, waitSignalStepHandler, waitTimerStepHandler } from "./signals.ts";

const TEST_DB = `/tmp/test-orchestrator-signals-${Date.now()}.sqlite`;

describe("orchestrator signals", () => {
  beforeAll(() => {
    initDashboardDb({ enabled: true, path: TEST_DB });
  });

  afterAll(() => {
    closeDashboardDb();
  });

  beforeEach(() => {
    const db = getDashboardDb()!;
    db.exec("DELETE FROM orchestrator_signals");
  });

  test("emit + consume signal roundtrip", () => {
    const instanceId = randomUUID();
    emitSignal(instanceId, "my-signal", { value: 42 });

    const result = consumeSignal(instanceId, "my-signal");
    expect(result).toEqual({ value: 42 });

    // Second consume returns null (already delivered)
    const result2 = consumeSignal(instanceId, "my-signal");
    expect(result2).toBeNull();
  });

  test("consumeSignal returns null when no signal exists", () => {
    const result = consumeSignal(randomUUID(), "no-such-signal");
    expect(result).toBeNull();
  });

  test("waitSignalStepHandler resolves immediately if signal already emitted", async () => {
    const instanceId = randomUUID();
    emitSignal(instanceId, "ready", { status: "go" });

    const result = await waitSignalStepHandler({ name: "ready", timeoutMs: 100 }, instanceId);
    expect(result.status).toBe("complete");
    expect(result.output).toEqual({ status: "go" });
  });

  test("waitSignalStepHandler times out and returns blocked", async () => {
    const instanceId = randomUUID();
    const result = await waitSignalStepHandler({ name: "never", timeoutMs: 50 }, instanceId);
    expect(result.status).toBe("blocked");
    expect(result.error).toBe("timeout");
  });

  test("waitTimerStepHandler resolves immediately if fireAt is in the past", async () => {
    const result = await waitTimerStepHandler({ fireAt: Date.now() - 1000 }, "ignored");
    expect(result.status).toBe("complete");
  });

  test("waitTimerStepHandler waits until fireAt", async () => {
    const start = Date.now();
    const fireAt = start + 100;
    const result = await waitTimerStepHandler({ fireAt }, "ignored");
    expect(result.status).toBe("complete");
    expect(Date.now()).toBeGreaterThanOrEqual(fireAt);
  });
});
