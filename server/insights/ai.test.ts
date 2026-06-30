import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import {
  buildAnalysisPrompt,
  getAiAnalysis,
  getAiAnalysisBySignature,
  parseAnalysisJson,
  signatureFor,
  upsertAiAnalysis,
} from "./ai.ts";
import { upsertInsight } from "./store.ts";
import type { Insight } from "./types.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;

function insight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: "insight_ops_disk_pressure",
    domain: "ops",
    severity: "medium",
    title: "Disk usage is high on the host",
    plainSummary: "The root filesystem is 88% full.",
    confidence: 0.9,
    evidenceRefs: [{ label: "df -h /", kind: "command", ref: "df -BG /", redacted: true }],
    actionDescriptorId: null,
    manualPageHref: "/infra",
    status: "open",
    tenant_id: "mimule",
    createdAt: 1_700_000_000_000,
    sourceKey: "ops:disk-pressure",
    ...overrides,
  };
}

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "insights-ai-test-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDashboardDb;
  if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function seedInsight(input: Partial<Insight> & Pick<Insight, "id" | "domain" | "title" | "plainSummary" | "sourceKey" | "createdAt">): Insight {
  const insight = upsertInsight({
    id: input.id,
    domain: input.domain,
    severity: input.severity ?? "high",
    title: input.title,
    plainSummary: input.plainSummary,
    confidence: input.confidence ?? 0.8,
    evidenceRefs: input.evidenceRefs ?? [{ label: "test evidence", kind: "log", ref: "test.log" }],
    actionDescriptorId: input.actionDescriptorId ?? null,
    manualPageHref: input.manualPageHref ?? "/insights",
    status: input.status ?? "open",
    createdAt: input.createdAt,
    sourceKey: input.sourceKey ?? undefined,
  });
  if (!insight) throw new Error(`Failed to seed insight ${input.id}`);
  return insight;
}

function section(prompt: string, heading: string, nextHeading: string): string {
  const start = prompt.indexOf(heading);
  const end = prompt.indexOf(nextHeading);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

describe("insights ai: pure helpers", () => {
  test("signatureFor keys on sourceKey + severity so escalation re-keys", () => {
    expect(signatureFor(insight())).toBe("ops:disk-pressure:medium");
    expect(signatureFor(insight({ severity: "high" }))).toBe("ops:disk-pressure:high");
    expect(signatureFor(insight({ sourceKey: null, id: "x" }))).toBe("x:medium");
  });

  test("buildAnalysisPrompt includes the key finding fields", () => {
    const prompt = buildAnalysisPrompt(insight());
    expect(prompt).toContain("Disk usage is high");
    expect(prompt).toContain("Severity: medium");
    expect(prompt).toContain("/infra");
    expect(prompt).toContain("df -h /");
    expect(prompt).toContain("recommended_action");
  });

  test("parseAnalysisJson handles raw JSON, fenced JSON, and prose-wrapped JSON", () => {
    const raw = `{"summary":"s","root_cause":"r","recommended_action":"a","confidence":0.8}`;
    expect(parseAnalysisJson(raw)).toEqual({ summary: "s", rootCause: "r", recommendedAction: "a", confidence: 0.8 });

    const fenced = "```json\n" + raw + "\n```";
    expect(parseAnalysisJson(fenced)?.summary).toBe("s");

    const prosey = `Here is my analysis:\n${raw}\nHope that helps.`;
    expect(parseAnalysisJson(prosey)?.recommendedAction).toBe("a");
  });

  test("parseAnalysisJson clamps confidence and rejects incomplete objects", () => {
    expect(parseAnalysisJson(`{"summary":"s","root_cause":"r","recommended_action":"a","confidence":5}`)?.confidence).toBe(1);
    expect(parseAnalysisJson(`{"summary":"s","root_cause":"r"}`)).toBeNull();
    expect(parseAnalysisJson("not json at all")).toBeNull();
    expect(parseAnalysisJson("")).toBeNull();
  });
});

test("analysis prompt includes recent history and related findings", () => {
  const base = 1_800_000_000_000;
  const target = seedInsight({
    id: "target",
    domain: "ops",
    severity: "critical",
    title: "Timer is failing repeatedly",
    plainSummary: "The scheduler timer failed on consecutive runs.",
    sourceKey: "scanner:ops:timer",
    createdAt: base,
  });
  seedInsight({
    id: "same-domain",
    domain: "ops",
    severity: "medium",
    title: "Service restart loop",
    plainSummary: "The control surface service restarted twice in ten minutes.",
    sourceKey: "scanner:ops:service",
    createdAt: base - 10_000,
  });
  seedInsight({
    id: "same-family",
    domain: "data",
    severity: "high",
    title: "Timer metadata is stale",
    plainSummary: "The same detector family reports stale timer state.",
    sourceKey: "scanner:ops:metadata",
    createdAt: base - 20_000,
  });
  seedInsight({
    id: "recent-security",
    domain: "security",
    severity: "low",
    title: "Credential posture changed",
    plainSummary: "A recent security finding gives the reasoner cross-domain history.",
    sourceKey: "scanner:security:secret",
    createdAt: base - 30_000,
  });
  getDashboardDb()!.query(`
    INSERT INTO action_audit (ts, actor, action_kind, action_id, target_type, target_id, result_status, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(base - 5_000, "operator", "deploy", "start-job:service:newsbites", "service", "newsbites", "failed", "restart failed");
  getDashboardDb()!.query(`
    INSERT INTO config_changes (ts, key, old_value_json, new_value_json, changed_by, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(base - 6_000, "autoapply.policy", "{}", "{\"tiers\":{}}", "operator", "raised threshold");
  getDashboardDb()!.query(`
    INSERT INTO jobs (id, ts, kind, state, status, target_type, target_id, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("job-test", base - 7_000, "doctor", "finished", "failed", "project", "dashboard", "timeout");

  const prompt = buildAnalysisPrompt(target);
  const related = section(prompt, "Recent related findings", "Recent platform finding history");
  const recent = section(prompt, "Recent platform finding history", "Recent platform actions");
  const platformHistory = section(prompt, "Recent platform actions, jobs, and config changes", "Respond with ONLY");

  expect(prompt).toContain("Use the recent history and related findings");
  expect(related).toContain("Service restart loop");
  expect(related).toContain("Timer metadata is stale");
  expect(related).not.toContain("Timer is failing repeatedly");
  expect(related).not.toContain("Credential posture changed");
  expect(recent).toContain("Credential posture changed");
  expect(recent).toContain("Service restart loop");
  expect(recent).not.toContain("Timer is failing repeatedly");
  expect(platformHistory).toContain("action deploy/start-job:service:newsbites");
  expect(platformHistory).toContain("config autoapply.policy changed");
  expect(platformHistory).toContain("job doctor finished/failed");
});

describe("insights ai: store roundtrip", () => {
  test("upsert then read by insight id and signature", () => {
    const saved = upsertAiAnalysis({
      signature: "ops:disk-pressure:medium",
      insightId: "insight_ops_disk_pressure",
      summary: "Disk is filling up.",
      rootCause: "Backups not pruned.",
      recommendedAction: "Prune old backups.",
      confidence: 0.82,
      model: "editorial-heavy",
    });
    expect(saved).not.toBeNull();
    expect(getAiAnalysis("insight_ops_disk_pressure")?.summary).toBe("Disk is filling up.");
    expect(getAiAnalysisBySignature("ops:disk-pressure:medium")?.recommendedAction).toBe("Prune old backups.");
  });

  test("upsert on the same signature overwrites (re-analyze)", () => {
    const base = { signature: "sig1", insightId: "i1", summary: "s1", rootCause: "r1", recommendedAction: "a1", confidence: 0.5, model: "m1" };
    upsertAiAnalysis(base);
    upsertAiAnalysis({ ...base, summary: "s2", model: "m2", generatedAt: Date.now() + 1000 });
    const got = getAiAnalysisBySignature("sig1");
    expect(got?.summary).toBe("s2");
    expect(got?.model).toBe("m2");
  });

  test("confidence is clamped to [0,1] on write", () => {
    upsertAiAnalysis({ signature: "sig2", insightId: "i2", summary: "s", rootCause: "r", recommendedAction: "a", confidence: 9, model: "m" });
    expect(getAiAnalysisBySignature("sig2")?.confidence).toBe(1);
  });
});
