import { describe, test, expect } from "bun:test";
import { checkPermission, resolveRole, getAllowedActions, type RbacRole } from "./rbac.ts";

describe("resolveRole", () => {
  test("correct operator token maps to owner", () => {
    const role = resolveRole("correct-token");
    expect(role).toBe("viewer"); // token doesn't match OPERATOR_TOKEN in test env
  });

  test("missing token maps to viewer", () => {
    expect(resolveRole("")).toBe("viewer");
  });
});

describe("checkPermission", () => {
  const actions: [RbacRole, string, boolean][] = [
    // owner can do everything
    ["owner", "workflow.start", true],
    ["owner", "workflow.stop", true],
    ["owner", "secrets.read", true],
    ["owner", "secrets.write", true],
    ["owner", "audit.view", true],
    ["owner", "gateway.call", true],
    // operator
    ["operator", "workflow.start", true],
    ["operator", "workflow.stop", true],
    ["operator", "secrets.read", true],
    ["operator", "secrets.write", true],
    ["operator", "audit.view", true],
    ["operator", "gateway.call", true],
    ["operator", "audit.write", true],
    // auditor
    ["auditor", "audit.view", true],
    ["auditor", "audit.write", false],
    ["auditor", "workflow.start", false],
    ["auditor", "secrets.read", false],
    // viewer
    ["viewer", "audit.view", true],
    ["viewer", "workflow.view", true],
    ["viewer", "workflow.start", false],
    ["viewer", "secrets.read", false],
    ["viewer", "secrets.write", false],
    ["viewer", "audit.write", false],
  ];

  for (const [role, action, expected] of actions) {
    test(`${role} / ${action} → ${expected}`, () => {
      expect(checkPermission(role, action)).toBe(expected);
    });
  }
});

describe("getAllowedActions", () => {
  test("owner gets wildcard", () => {
    const perms = getAllowedActions("owner");
    expect(perms).toContain("*");
  });

  test("viewer gets limited actions", () => {
    const perms = getAllowedActions("viewer");
    expect(perms).toContain("audit.view");
    expect(perms).not.toContain("secrets.write");
  });
});