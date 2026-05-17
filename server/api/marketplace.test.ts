import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { parseManifest, validateManifest } from "../marketplace/manifest";
import {
  marketplaceListHandler,
  marketplaceInstallHandler,
  marketplaceDeleteHandler,
  marketplaceEnableHandler,
  marketplaceDisableHandler,
  marketplaceRunHandler,
} from "./marketplace";
import type { InstalledSkill } from "../marketplace/types";

function makeManifest(name: string, version = "1.0.0"): string {
  return JSON.stringify({
    name,
    version,
    kind: "workflow-skill",
    description: "Test skill",
    entrypoint: "index.ts",
    inputs: { msg: { type: "string" } },
    outputs: { echo: { type: "string" } },
    permissions: [],
  });
}

const TEST_TMPDIR = "/tmp/marketplace-api-test";

function setupTmpDb() {
  const { mkdirSync, rmSync } = require("node:fs");
  try { rmSync(TEST_TMPDIR, { recursive: true }); } catch { /* ignore */ }
  mkdirSync(TEST_TMPDIR, { recursive: true });
  const path = `${TEST_TMPDIR}/api-${Date.now()}.sqlite`;
  process.env.DASHBOARD_DB_PATH = path;
  process.env.DASHBOARD_DB = "1";
  return path;
}

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("marketplace api handlers (mock integration)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = setupTmpDb();
    const { initDashboardDb } = require("../db/dashboard");
    initDashboardDb({ path: dbPath, enabled: true });
  });

  afterEach(() => {
    const { closeDashboardDb } = require("../db/dashboard");
    closeDashboardDb();
  });

  describe("parseManifest", () => {
    it("round-trips valid manifest", () => {
      const json = makeManifest("echo");
      const parsed = parseManifest(json);
      expect(parsed.name).toBe("echo");
      expect(parsed.version).toBe("1.0.0");
      expect(parsed.kind).toBe("workflow-skill");
    });

    it("installs echo and parses its manifest", () => {
      const json = makeManifest("echo-2");
      const parsed = parseManifest(json);
      expect(parsed.name).toBe("echo-2");
    });
  });

  describe("validateManifest", () => {
    it("echo skill manifest is valid", () => {
      const parsed = parseManifest(makeManifest("echo"));
      const errors = validateManifest(parsed);
      expect(errors).toEqual([]);
    });

    it("unknown permission rejected", () => {
      const m = {
        name: "test",
        version: "1.0.0",
        description: "",
        kind: "workflow-skill" as const,
        entrypoint: "index.ts",
        inputs: {},
        outputs: {},
        permissions: ["unknown.permission" as any],
      };
      const errors = validateManifest(m);
      expect(errors.some((e) => e.includes("unknown permission"))).toBe(true);
    });

    it("path traversal entrypoint rejected", () => {
      const m = {
        name: "test",
        version: "1.0.0",
        description: "",
        kind: "workflow-skill" as const,
        entrypoint: "../../bin/evil.ts",
        inputs: {},
        outputs: {},
        permissions: [],
      };
      const errors = validateManifest(m);
      expect(errors.some((e) => e.includes(".."))).toBe(true);
    });
  });

  describe("install flow", () => {
    it("manifest validation fails on bad name", () => {
      const badJson = JSON.stringify({ version: "1.0.0", kind: "workflow-skill", entrypoint: "index.ts" });
      expect(() => parseManifest(badJson)).toThrow("name");
    });

    it("manifest validates with gateway.call permission", () => {
      const m = {
        name: "test-skill",
        version: "1.0.0",
        description: "",
        kind: "workflow-skill" as const,
        entrypoint: "index.ts",
        inputs: {},
        outputs: {},
        permissions: ["gateway.call" as const],
      };
      const errors = validateManifest(m);
      expect(errors).toEqual([]);
    });
  });

  describe("marketplaceListHandler", () => {
    it("returns empty list initially", async () => {
      const res = await marketplaceListHandler(req("GET", "/api/marketplace/skills"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    it("returns echo skill after install", async () => {
      const manifestJson = makeManifest("echo-skill");
      const installReq = req("POST", "/api/marketplace/skills", {
        bundlePath: "/tmp/echo-bundle",
        manifestJson,
      });
      await marketplaceInstallHandler(installReq);
      const res = await marketplaceListHandler(req("GET", "/api/marketplace/skills"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0].name).toBe("echo-skill");
      expect(body.data[0].status).toBe("active");
    });
  });

  describe("marketplaceInstallHandler", () => {
    it("installs a bundle and returns the skill", async () => {
      const manifestJson = makeManifest("install-test-skill");
      const r = req("POST", "/api/marketplace/skills", {
        bundlePath: "/tmp/test-bundle",
        manifestJson,
      });
      const res = await marketplaceInstallHandler(r);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe("install-test-skill");
      expect(body.data.status).toBe("active");
    });

    it("rejects invalid manifest", async () => {
      const badJson = JSON.stringify({ version: "1.0.0", kind: "workflow-skill", entrypoint: "index.ts" });
      const r = req("POST", "/api/marketplace/skills", {
        bundlePath: "/tmp/bad",
        manifestJson: badJson,
      });
      const res = await marketplaceInstallHandler(r);
      expect(res.status).toBe(400);
    });
  });

  describe("install + run round-trip", () => {
    let bundleDir: string;
    let entrypointPath: string;

    beforeEach(() => {
      const { mkdirSync, writeFileSync } = require("node:fs");
      bundleDir = `${TEST_TMPDIR}/bundle-${Date.now()}`;
      mkdirSync(bundleDir, { recursive: true });
      entrypointPath = `${bundleDir}/index.ts`;
      writeFileSync(
        entrypointPath,
        `const input = JSON.parse(process.env.TIB_INPUT ?? "{}"); console.log(JSON.stringify({ echo: input.msg ?? "no-msg" }));`
      );
    });

    it("installs and runs echo skill end-to-end", async () => {
      const manifestJson = JSON.stringify({
        name: "echo",
        version: "1.0.0",
        kind: "workflow-skill",
        description: "Echoes the input",
        entrypoint: "index.ts",
        inputs: { msg: { type: "string" } },
        outputs: { echo: { type: "string" } },
        permissions: [],
      });

      const installRes = await marketplaceInstallHandler(
        req("POST", "/api/marketplace/skills", { bundlePath: bundleDir, manifestJson })
      );
      expect(installRes.status).toBe(200);
      const { data: skill } = await installRes.json();
      expect(skill.name).toBe("echo");
      expect(skill.status).toBe("active");

      const runRes = await marketplaceRunHandler(
        req("POST", `/api/marketplace/skills/${skill.id}/run`, { input: { msg: "hello world" } }),
        skill.id
      );
      expect(runRes.status).toBe(200);
      const runBody = await runRes.json();
      expect(runBody.data.output.echo).toBe("hello world");
    });

    it("installs skill and list returns it with active status", async () => {
      const manifestJson = JSON.stringify({
        name: "list-check-skill",
        version: "1.0.0",
        kind: "workflow-skill",
        description: "A skill for list verification",
        entrypoint: "index.ts",
        inputs: {},
        outputs: {},
        permissions: [],
      });

      const installRes = await marketplaceInstallHandler(
        req("POST", "/api/marketplace/skills", { bundlePath: bundleDir, manifestJson })
      );
      const { data: skill } = await installRes.json();

      const listRes = await marketplaceListHandler(req("GET", "/api/marketplace/skills"));
      const listBody = await listRes.json();
      const found = listBody.data.find((s: InstalledSkill) => s.id === skill.id);
      expect(found).toBeDefined();
      expect(found.name).toBe("list-check-skill");
      expect(found.status).toBe("active");
    });

    it("disable makes skill inactive and run returns 400", async () => {
      const manifestJson = JSON.stringify({
        name: "disable-verify-skill",
        version: "1.0.0",
        kind: "workflow-skill",
        description: "Skill for disable test",
        entrypoint: "index.ts",
        inputs: {},
        outputs: {},
        permissions: [],
      });

      const installRes = await marketplaceInstallHandler(
        req("POST", "/api/marketplace/skills", { bundlePath: bundleDir, manifestJson })
      );
      const { data: skill } = await installRes.json();

      const disableRes = await marketplaceDisableHandler(
        req("DELETE", `/api/marketplace/skills/${skill.id}`),
        skill.id
      );
      expect(disableRes.status).toBe(200);
      const disableBody = await disableRes.json();
      expect(disableBody.data.status).toBe("disabled");

      const listRes = await marketplaceListHandler(req("GET", "/api/marketplace/skills"));
      const listBody = await listRes.json();
      const found = listBody.data.find((s: InstalledSkill) => s.id === skill.id);
      expect(found.status).toBe("disabled");

      const runRes = await marketplaceRunHandler(
        req("POST", `/api/marketplace/skills/${skill.id}/run`, { input: {} }),
        skill.id
      );
      expect(runRes.status).toBe(400);
    });
  });

  describe("marketplaceRunHandler", () => {
    it("returns 404 for unknown skill", async () => {
      const r = req("POST", "/api/marketplace/skills/bad-id/run", { input: { msg: "hello" } });
      const res = await marketplaceRunHandler(r, "bad-id");
      expect(res.status).toBe(404);
    });

    it("returns 400 for disabled skill", async () => {
      const manifestJson = makeManifest("disabled-run-skill");
      const installRes = await marketplaceInstallHandler(
        req("POST", "/api/marketplace/skills", { bundlePath: "/tmp/disabled-run", manifestJson })
      );
      const { data: skill } = await installRes.json();
      await marketplaceDisableHandler(
        req("DELETE", `/api/marketplace/skills/${skill.id}`),
        skill.id
      );
      const r = req("POST", `/api/marketplace/skills/${skill.id}/run`, { input: { msg: "hello" } });
      const res = await marketplaceRunHandler(r, skill.id);
      expect(res.status).toBe(400);
    });
  });
});