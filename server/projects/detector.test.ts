import { describe, it, expect } from "bun:test";
import { detectProject } from "./detector.ts";

describe("detectProject", () => {
  it("detects bun+typescript project from /opt/opencode-control-surface", () => {
    const result = detectProject("/opt/opencode-control-surface");
    expect(result.language).toBe("typescript");
    expect(result.framework).toBe("bun");
    expect(result.validatorCommands).toContain("bun run check");
    expect(result.repoPath).toBe("/opt/opencode-control-surface");
  });

  it("returns partial config (no id, tenantId, etc.)", () => {
    const result = detectProject("/opt/opencode-control-surface");
    expect((result as Record<string, unknown>).id).toBeUndefined();
    expect((result as Record<string, unknown>).tenantId).toBeUndefined();
  });

  it("returns empty object for unknown/nonexistent repo", () => {
    const result = detectProject("/nonexistent/path/that/does/not/exist");
    expect(result).toEqual({});
  });

  it("returns empty object for empty string path", () => {
    const result = detectProject("");
    expect(result).toEqual({});
  });
});
