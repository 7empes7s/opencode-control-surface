import { describe, expect, test } from "bun:test";
import { repeatedValidationFailurePauseReason, tmuxSocket } from "./runner.ts";
import type { BuilderPass, BuilderValidation } from "./store.ts";

describe("tmuxSocket", () => {
  test("returns tib-mimule for mimule tenant", () => {
    expect(tmuxSocket("mimule")).toBe("tib-mimule");
  });

  test("returns tib-acme for acme tenant", () => {
    expect(tmuxSocket("acme")).toBe("tib-acme");
  });

  test("returns tib-<id> for any tenant id", () => {
    expect(tmuxSocket("t-alpha")).toBe("tib-t-alpha");
    expect(tmuxSocket("t-beta")).toBe("tib-t-beta");
    expect(tmuxSocket("my-org")).toBe("tib-my-org");
  });
});

function pass(id: string, sequence: number): BuilderPass {
  return {
    id,
    runId: "br_test",
    workflowId: "bw_test",
    sequence,
    phase: "build",
    status: "failed",
    agent: "codex",
    model: "o4-mini",
    provider: null,
    modelReason: null,
    startedAt: sequence,
    finishedAt: sequence + 1,
    jobIds: [],
    validationIds: [],
    artifactIds: [],
    summary: null,
    nextInstruction: null,
    error: null,
    failureClass: null,
    analyticsJson: null,
    planItemsDone: null,
    planItemsRemaining: null,
    completionPercent: null,
    traceId: null,
  };
}

function validation(passId: string, status: string, command = "bun run build"): BuilderValidation {
  return {
    id: `bv_${passId}`,
    workflowId: "bw_test",
    runId: "br_test",
    passId,
    kind: "build",
    status,
    command,
    url: null,
    startedAt: 1,
    finishedAt: 2,
    outputTail: null,
    artifactId: null,
    error: status === "success" ? null : "build failed",
  };
}

describe("repeatedValidationFailurePauseReason", () => {
  test("returns a pause reason after the configured consecutive validation failure threshold", () => {
    const reason = repeatedValidationFailurePauseReason(
      [pass("bp_1", 1), pass("bp_2", 2), pass("bp_3", 3)],
      [validation("bp_1", "failed"), validation("bp_2", "failed"), validation("bp_3", "failed")],
      3,
    );

    expect(reason).toContain("3 consecutive passes ended with validation failures");
    expect(reason).toContain("bun run build");
  });

  test("does not pause when a recent validation pass breaks the failure streak", () => {
    const reason = repeatedValidationFailurePauseReason(
      [pass("bp_1", 1), pass("bp_2", 2), pass("bp_3", 3)],
      [validation("bp_1", "failed"), validation("bp_2", "failed"), validation("bp_3", "success")],
      3,
    );

    expect(reason).toBeNull();
  });
});
