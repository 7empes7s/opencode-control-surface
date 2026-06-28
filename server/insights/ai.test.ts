import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import {
  signatureFor,
  parseAnalysisJson,
  buildAnalysisPrompt,
  upsertAiAnalysis,
  getAiAnalysis,
  getAiAnalysisBySignature,
} from "./ai.ts";
import type { Insight } from "./types.ts";

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

describe("insights ai: store roundtrip", () => {
  let tempDir: string;
  let prevDb: string | undefined;
  let prevDbPath: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "ai-analysis-test-"));
    prevDb = process.env.DASHBOARD_DB;
    prevDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    closeDashboardDb();
    if (prevDb === undefined) delete process.env.DASHBOARD_DB; else process.env.DASHBOARD_DB = prevDb;
    if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH; else process.env.DASHBOARD_DB_PATH = prevDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

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
