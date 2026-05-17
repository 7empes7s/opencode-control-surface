import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const SDK_DIR = "/tmp/tib-sdk-test";
const FIXTURE_SCRIPT = `${SDK_DIR}/fixture-skill.ts`;

function makeSkillScript(handlerBody: string): string {
  return `
import { defineSkill } from "${process.cwd()}/sdk/index.ts";

defineSkill(
  {
    name: "test-skill",
    version: "1.0.0",
    kind: "workflow-skill",
    description: "Test skill",
    entrypoint: "index.ts",
    inputs: { msg: { type: "string" } },
    outputs: { echo: { type: "string" } },
    permissions: [],
  },
  ${handlerBody}
);
`;
}

describe("sdk defineSkill", () => {
  beforeEach(() => {
    rmSync(SDK_DIR, { recursive: true, force: true });
    mkdirSync(SDK_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(SDK_DIR, { recursive: true, force: true });
  });

  it("handler receives parsed input and stdout gets JSON output", async () => {
    const script = makeSkillScript("(input) => ({ echo: input.msg })");
    writeFileSync(FIXTURE_SCRIPT, script, "utf8");

    const proc = Bun.spawn(["bun", "run", FIXTURE_SCRIPT], {
      env: {
        ...process.env,
        TIB_SKILL_ID: "test-skill-123",
        TIB_TENANT_ID: "mimule",
        TIB_INSTANCE_ID: "instance-456",
        TIB_PERMISSIONS: "",
        TIB_INPUT: JSON.stringify({ msg: "hello world" }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual({ echo: "hello world" });
  });

  it("exits with error when handler throws", async () => {
    const script = makeSkillScript("() => { throw new Error('boom'); }");
    writeFileSync(FIXTURE_SCRIPT, script, "utf8");

    const proc = Bun.spawn(["bun", "run", FIXTURE_SCRIPT], {
      env: {
        ...process.env,
        TIB_SKILL_ID: "test-skill-123",
        TIB_TENANT_ID: "mimule",
        TIB_INSTANCE_ID: "instance-456",
        TIB_PERMISSIONS: "",
        TIB_INPUT: "{}",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  });

  it("exits with error when env vars are missing", async () => {
    const script = makeSkillScript("() => ({})");
    writeFileSync(FIXTURE_SCRIPT, script, "utf8");

    const proc = Bun.spawn(["bun", "run", FIXTURE_SCRIPT], {
      env: { ...process.env, TIB_SKILL_ID: "", TIB_TENANT_ID: "", TIB_INSTANCE_ID: "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  });
});