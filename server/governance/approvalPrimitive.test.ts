import { describe, expect, test } from "bun:test";
import {
  canonicalApprovalArguments,
  evaluateExplicitConfirmation,
  evaluateUnattendedApproval,
  issueAndConsumePermit,
} from "./approvalPrimitive.ts";

describe("shared approval primitive", () => {
  test("kill switch takes precedence over budget and confirmation", () => {
    let budgetChecked = false;
    const result = evaluateExplicitConfirmation({
      confirmed: false,
      killSwitchEnabled: true,
      budgetGuard: () => {
        budgetChecked = true;
        return { allowed: false, error: "budget exceeded" };
      },
    });

    expect(result).toEqual({ allowed: false, code: "KILL_SWITCHED", error: "approval disabled by kill switch" });
    expect(budgetChecked).toBe(false);
  });

  test("budget guard denies before confirmation and confirmation is literal true", () => {
    const budgetDenied = evaluateExplicitConfirmation({
      confirmed: false,
      budgetGuard: () => ({ allowed: false, error: "budget exceeded" }),
    });
    expect(budgetDenied).toEqual({ allowed: false, code: "BUDGET_DENIED", error: "budget exceeded" });

    expect(evaluateExplicitConfirmation({ confirmed: new Boolean(true) })).toEqual({
      allowed: false,
      code: "CONFIRM_REQUIRED",
      error: "confirmation required",
    });
    expect(evaluateExplicitConfirmation({ confirmed: true })).toEqual({ allowed: true });
  });

  test("unattended approval is opt-in", () => {
    expect(evaluateUnattendedApproval({ enabled: false }).allowed).toBe(false);
    expect(evaluateUnattendedApproval({ enabled: true })).toEqual({ allowed: true });
  });

  test("canonical argument representation is key-order independent", () => {
    expect(canonicalApprovalArguments({ b: [2, { y: true, x: "v" }], a: 1 }))
      .toBe(canonicalApprovalArguments({ a: 1, b: [2, { x: "v", y: true }] }));
    expect(() => canonicalApprovalArguments({ createdAt: new Date() })).toThrow("plain JSON objects");
  });

  test("issues once and consumes the same argument-bound permit once", async () => {
    const args = { agentId: "agent-1", prompt: "synthetic only" };
    const calls: string[] = [];
    const result = await issueAndConsumePermit({
      args,
      issue: async (issuedArgs) => {
        calls.push(`issue:${canonicalApprovalArguments(issuedArgs)}`);
        return { issued: true as const, permit: "permit-1" };
      },
      consume: async (consumedArgs, permit) => {
        calls.push(`consume:${permit}:${canonicalApprovalArguments(consumedArgs)}`);
        return "consumed";
      },
      argumentsChanged: () => "changed",
    });

    expect(result).toBe("consumed");
    expect(calls).toEqual([
      'issue:{"agentId":"agent-1","prompt":"synthetic only"}',
      'consume:permit-1:{"agentId":"agent-1","prompt":"synthetic only"}',
    ]);
  });

  test("never consumes a permit when issuance fails or its arguments mutate", async () => {
    let consumeCalls = 0;
    const denied = await issueAndConsumePermit({
      args: { agentId: "agent-1" },
      issue: async () => ({ issued: false as const, result: "issuer refused" }),
      consume: async () => {
        consumeCalls++;
        return "consumed";
      },
      argumentsChanged: () => "changed",
    });
    expect(denied).toBe("issuer refused");
    expect(consumeCalls).toBe(0);

    const mutableArgs = { agentId: "agent-1", prompt: "before" };
    const changed = await issueAndConsumePermit({
      args: mutableArgs,
      issue: async (issuedArgs) => {
        issuedArgs.prompt = "after";
        return { issued: true as const, permit: "permit-1" };
      },
      consume: async () => {
        consumeCalls++;
        return "consumed";
      },
      argumentsChanged: () => "changed",
    });
    expect(changed).toBe("changed");
    expect(consumeCalls).toBe(0);
  });
});
