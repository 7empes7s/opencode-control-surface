import { describe, test, expect, beforeAll } from "bun:test";
import { evaluatePolicy, loadPolicyDocument, type PolicyDocument, type PolicyEventContext } from "./policy.ts";

beforeAll(() => {});

describe("evaluatePolicy", () => {
  test("allow-default when no rules match", () => {
    const doc: PolicyDocument = {
      name: "test",
      version: "1.0.0",
      rules: [],
    };
    const ctx: PolicyEventContext = { event: "workflow.start" };
    const result = evaluatePolicy(doc, ctx);
    expect(result.effect).toBe("allow");
    expect(result.reason).toContain("no matching rule");
  });

  test("first-match-wins deny", () => {
    const doc: PolicyDocument = {
      name: "test",
      version: "1.0.0",
      rules: [
        { name: "deny-all", event: "*", effect: "deny" },
        { name: "allow-all", event: "*", effect: "allow" },
      ],
    };
    const ctx: PolicyEventContext = { event: "workflow.start" };
    const result = evaluatePolicy(doc, ctx);
    expect(result.effect).toBe("deny");
    expect(result.ruleName).toBe("deny-all");
  });

  test("require_approval triggers when matched", () => {
    const doc: PolicyDocument = {
      name: "test",
      version: "1.0.0",
      rules: [
        {
          name: "prod-approval",
          event: "workflow.start",
          effect: "require_approval",
          reason: "Production requires approval",
          conditions: { environment: "production" },
        },
      ],
    };
    const ctx: PolicyEventContext = { event: "workflow.start", environment: "production" };
    const result = evaluatePolicy(doc, ctx);
    expect(result.effect).toBe("require_approval");
    expect(result.ruleName).toBe("prod-approval");
  });

  test("condition not met — skip rule", () => {
    const doc: PolicyDocument = {
      name: "test",
      version: "1.0.0",
      rules: [
        {
          name: "prod-approval",
          event: "workflow.start",
          effect: "deny",
          conditions: { environment: "production" },
        },
      ],
    };
    const ctx: PolicyEventContext = { event: "workflow.start", environment: "staging" };
    const result = evaluatePolicy(doc, ctx);
    expect(result.effect).toBe("allow");
    expect(result.ruleName).toBeUndefined();
  });

  test("wildcard event match", () => {
    const doc: PolicyDocument = {
      name: "test",
      version: "1.0.0",
      rules: [{ name: "deny-all", event: "*", effect: "deny" }],
    };
    const result = evaluatePolicy(doc, { event: "anything.here" });
    expect(result.effect).toBe("deny");
  });

  test("log-only is recorded but not enforced by evaluatePolicy", () => {
    const doc: PolicyDocument = {
      name: "test",
      version: "1.0.0",
      rules: [{ name: "log-all", event: "*", effect: "log-only" }],
    };
    const result = evaluatePolicy(doc, { event: "workflow.start" });
    expect(result.effect).toBe("log-only");
    expect(result.ruleName).toBe("log-all");
  });
});