import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeData } from "../api/types.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "./dashboard.ts";
import { __resetSamplerStateForTests, detectHomeTransitions, runHomeSampler } from "./sampler.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousDoctorLogPath: string | undefined;
let previousDoctorLogWarnBytes: string | undefined;
let previousDoctorLogCritBytes: string | undefined;
let previousBackupRoot: string | undefined;
let previousBackupStaleMs: string | undefined;
let previousContentArticlesPath: string | undefined;
let previousContentPublicPath: string | undefined;
let previousContentAllowedVerticals: string | undefined;
let previousContentDigestMinWords: string | undefined;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function registerSamplerTests(): void {
  beforeEach(() => {
    closeDashboardDb();
    __resetSamplerStateForTests();
    tempDir = mkdtempSync(join(tmpdir(), "dashboard-sampler-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    previousDoctorLogPath = process.env.DASHBOARD_DOCTOR_LOG_PATH;
    previousDoctorLogWarnBytes = process.env.DASHBOARD_DOCTOR_LOG_WARN_BYTES;
    previousDoctorLogCritBytes = process.env.DASHBOARD_DOCTOR_LOG_CRIT_BYTES;
    previousBackupRoot = process.env.DASHBOARD_BACKUP_ROOT;
    previousBackupStaleMs = process.env.DASHBOARD_BACKUP_STALE_MS;
    previousContentArticlesPath = process.env.DASHBOARD_CONTENT_ARTICLES_PATH;
    previousContentPublicPath = process.env.DASHBOARD_CONTENT_PUBLIC_PATH;
    previousContentAllowedVerticals = process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS;
    previousContentDigestMinWords = process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS;
    process.env.DASHBOARD_CONTENT_ARTICLES_PATH = join(tempDir, "missing-content");
  });

  afterEach(() => {
    closeDashboardDb();
    __resetSamplerStateForTests();

    if (previousDashboardDb === undefined) {
      delete process.env.DASHBOARD_DB;
    } else {
      process.env.DASHBOARD_DB = previousDashboardDb;
    }

    if (previousDashboardDbPath === undefined) {
      delete process.env.DASHBOARD_DB_PATH;
    } else {
      process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    }

    restoreEnv("DASHBOARD_DOCTOR_LOG_PATH", previousDoctorLogPath);
    restoreEnv("DASHBOARD_DOCTOR_LOG_WARN_BYTES", previousDoctorLogWarnBytes);
    restoreEnv("DASHBOARD_DOCTOR_LOG_CRIT_BYTES", previousDoctorLogCritBytes);
    restoreEnv("DASHBOARD_BACKUP_ROOT", previousBackupRoot);
    restoreEnv("DASHBOARD_BACKUP_STALE_MS", previousBackupStaleMs);
    restoreEnv("DASHBOARD_CONTENT_ARTICLES_PATH", previousContentArticlesPath);
    restoreEnv("DASHBOARD_CONTENT_PUBLIC_PATH", previousContentPublicPath);
    restoreEnv("DASHBOARD_CONTENT_ALLOWED_VERTICALS", previousContentAllowedVerticals);
    restoreEnv("DASHBOARD_CONTENT_DIGEST_MIN_WORDS", previousContentDigestMinWords);

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("no-op when DB disabled", () => {
    delete process.env.DASHBOARD_DB;
    closeDashboardDb();

    expect(() => runHomeSampler(stubHome())).not.toThrow();
    expect(getDashboardDb()).toBeNull();
  });

  test("metrics are not deduped", () => {
    openTempDb();

    runHomeSampler(stubHome());
    runHomeSampler(stubHome());

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM metric_samples
      WHERE source = ? AND key = ?
    `).get("gpu", "status") as { count: number };

    expect(row.count).toBeGreaterThanOrEqual(2);
  });

  test("transitions are deduped within a minute", () => {
    openTempDb();

    runHomeSampler(stubHome({ serviceStatus: "active" }));
    runHomeSampler(stubHome({ serviceStatus: "failed" }));
    runHomeSampler(stubHome({ serviceStatus: "failed" }));

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind = ? AND entity_type = ? AND entity_id = ?
    `).get("service.state", "service", "litellm") as { count: number };

    expect(row.count).toBe(1);
  });

  test("service transition emits one event", () => {
    openTempDb();

    runHomeSampler(stubHome({ serviceStatus: "active" }));
    runHomeSampler(stubHome({ serviceStatus: "failed" }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary
      FROM events
      WHERE kind = ?
    `).all("service.state") as Array<{ kind: string; severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("active → failed");
  });

  test("GPU down emits error", () => {
    openTempDb();

    runHomeSampler(stubHome({ gpuStatus: "up" }));
    runHomeSampler(stubHome({ gpuStatus: "down" }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity
      FROM events
      WHERE kind = ?
    `).all("gpu.status") as Array<{ kind: string; severity: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
  });

  test("vast runway thresholds emit warning and critical events", () => {
    openTempDb();

    runHomeSampler(stubHome({ runwayHours: 30 }));
    runHomeSampler(stubHome({ runwayHours: 18 }));
    runHomeSampler(stubHome({ runwayHours: 10 }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary, payload_json
      FROM events
      WHERE kind IN (?, ?)
      ORDER BY rowid ASC
    `).all("vast.runway_warning", "vast.runway_critical") as Array<{
      kind: string;
      severity: string;
      summary: string;
      payload_json: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe("vast.runway_warning");
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].summary).toContain("18h");
    expect(rows[1].kind).toBe("vast.runway_critical");
    expect(rows[1].severity).toBe("error");
    expect(JSON.parse(rows[1].payload_json).runwayHours).toBe(10);
  });

  test("first call seeds and does not emit", () => {
    openTempDb();
    __resetSamplerStateForTests();

    runHomeSampler(stubHome());

    const events = getDashboardDb()!.query("SELECT COUNT(*) AS count FROM events").get() as { count: number };
    const samples = getDashboardDb()!.query("SELECT COUNT(*) AS count FROM metric_samples").get() as { count: number };

    expect(events.count).toBe(0);
    expect(samples.count).toBeGreaterThan(0);
  });

  test("disk bucket transition emits one event", () => {
    openTempDb();

    runHomeSampler(stubHome({ diskUsedPct: 50 }));
    runHomeSampler(stubHome({ diskUsedPct: 90 }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary
      FROM events
      WHERE kind = ?
    `).all("disk.bucket") as Array<{ kind: string; severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("%");
  });

  test("disk staying within same bucket emits no event", () => {
    openTempDb();

    runHomeSampler(stubHome({ diskUsedPct: 75 }));
    runHomeSampler(stubHome({ diskUsedPct: 78 }));

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind = ?
    `).get("disk.bucket") as { count: number };

    expect(row.count).toBe(0);
  });

  test("disk projected full detector emits event from metric trend", () => {
    openTempDb();
    insertDiskSample(Date.now() - 2 * 24 * 60 * 60 * 1000, 75);

    runHomeSampler(stubHome({ diskUsedPct: 76 }));
    runHomeSampler(stubHome({ diskUsedPct: 84 }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("disk.projected_full") as Array<{ severity: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("90%");
    expect(JSON.parse(rows[0].payload_json).daysTo90).toBeLessThanOrEqual(7);
  });

  test("disk projected full detector ignores flat or shrinking trend", () => {
    openTempDb();
    insertDiskSample(Date.now() - 2 * 24 * 60 * 60 * 1000, 80);

    runHomeSampler(stubHome({ diskUsedPct: 78 }));
    runHomeSampler(stubHome({ diskUsedPct: 76 }));

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind = ?
    `).get("disk.projected_full") as { count: number };

    expect(row.count).toBe(0);
  });

  test("doctor log size detector emits a warning event", () => {
    openTempDb();
    const doctorLogPath = join(tempDir, "doctor-log.jsonl");
    process.env.DASHBOARD_DOCTOR_LOG_PATH = doctorLogPath;
    process.env.DASHBOARD_DOCTOR_LOG_WARN_BYTES = "8";
    process.env.DASHBOARD_DOCTOR_LOG_CRIT_BYTES = "16";
    writeFileSync(doctorLogPath, "ok\n");

    runHomeSampler(stubHome());
    writeFileSync(doctorLogPath, "large-log\n\n");
    runHomeSampler(stubHome());

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, payload_json
      FROM events
      WHERE kind = ?
    `).all("disk.doctor_log_large") as Array<{ severity: string; entity_id: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].entity_id).toBe("doctor-log.jsonl");
    expect(JSON.parse(rows[0].payload_json).bucket).toBe("large");
  });

  test("backup freshness detector emits stale event", () => {
    openTempDb();
    const backupRoot = join(tempDir, "backups");
    const backupDir = join(backupRoot, "2026-05-18");
    mkdirSync(backupDir, { recursive: true });
    process.env.DASHBOARD_BACKUP_ROOT = backupRoot;
    process.env.DASHBOARD_BACKUP_STALE_MS = String(60 * 60 * 1000);

    runHomeSampler(stubHome());
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(backupDir, oldDate, oldDate);
    runHomeSampler(stubHome());

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, payload_json
      FROM events
      WHERE kind = ?
    `).all("backup.stale") as Array<{ severity: string; entity_id: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].entity_id).toBe("mimule");
    expect(JSON.parse(rows[0].payload_json).bucket).toBe("stale");
  });

  test("memory pressure detector emits event after sustained high usage", () => {
    openTempDb();

    runHomeSampler(stubHome({ memUsedPct: 91 }));
    insertHetznerSample(Date.now() - 5.5 * 60 * 1000, { memUsedPct: 91, diskUsedPct: 60 });
    runHomeSampler(stubHome({ memUsedPct: 92 }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("infra.memory_pressure") as Array<{ severity: string; entity_id: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].entity_id).toBe("memory");
    expect(rows[0].summary).toContain("memory pressure");
    expect(JSON.parse(rows[0].payload_json).minPct).toBeGreaterThanOrEqual(90);
  });

  test("disk pressure detector emits infra event at threshold", () => {
    openTempDb();

    runHomeSampler(stubHome({ diskUsedPct: 70 }));
    runHomeSampler(stubHome({ diskUsedPct: 86 }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("infra.disk_pressure") as Array<{ severity: string; entity_id: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].entity_id).toBe("disk");
    expect(rows[0].summary).toContain("86%");
    expect(JSON.parse(rows[0].payload_json).diskUsedPct).toBe(86);
  });

  test("restart storm detector emits service event from sampled status history", () => {
    openTempDb();

    runHomeSampler(stubHome());
    insertServiceSamples("litellm", [
      "failed",
      "active",
      "inactive",
      "active",
      "failed",
      "active",
      "unknown",
      "active",
    ]);
    runHomeSampler(stubHome());

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("infra.restart_storm") as Array<{ severity: string; entity_id: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].entity_id).toBe("litellm");
    expect(rows[0].summary).toContain("4 times");
    expect(JSON.parse(rows[0].payload_json).restarts).toBe(4);
  });

  test("tunnel flapping detector emits vast tunnel event", () => {
    openTempDb();

    runHomeSampler(stubHome());
    insertServiceSamples("vast-tunnel", [
      "failed",
      "active",
      "inactive",
      "active",
      "failed",
      "active",
    ]);
    runHomeSampler(stubHome());

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("infra.tunnel_flapping") as Array<{ severity: string; entity_id: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].entity_id).toBe("vast-tunnel");
    expect(rows[0].summary).toContain("flapped 3 times");
    expect(JSON.parse(rows[0].payload_json).windowMinutes).toBe(30);
  });

  test("cost anomaly detector emits burn spike event from Vast hourly rate trend", () => {
    openTempDb();
    const now = Date.now();
    insertVastRunwaySample(now - 3 * 60 * 60 * 1000, { hourlyRate: 1, runwayHours: 48 });
    insertVastRunwaySample(now - 2 * 60 * 60 * 1000, { hourlyRate: 1, runwayHours: 48 });
    const prev = detectHomeTransitions(stubHome({ hourlyRate: 1, runwayHours: 48 }), null);

    insertVastRunwaySample(now, { hourlyRate: 3, runwayHours: 10 });
    detectHomeTransitions(stubHome({ hourlyRate: 3, runwayHours: 10 }), prev);

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("vast.burn_spike") as Array<{ severity: string; entity_id: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].entity_id).toBe("burn_rate");
    expect(rows[0].summary).toContain("$3.00/h");
    expect(JSON.parse(rows[0].payload_json).multiplier).toBeGreaterThanOrEqual(2);
  });

  test("cost anomaly detector ignores small Vast hourly rate drift", () => {
    openTempDb();
    const now = Date.now();
    insertVastRunwaySample(now - 3 * 60 * 60 * 1000, { hourlyRate: 1, runwayHours: 48 });
    insertVastRunwaySample(now - 2 * 60 * 60 * 1000, { hourlyRate: 1, runwayHours: 48 });
    const prev = detectHomeTransitions(stubHome({ hourlyRate: 1, runwayHours: 48 }), null);

    insertVastRunwaySample(now, { hourlyRate: 1.1, runwayHours: 43 });
    detectHomeTransitions(stubHome({ hourlyRate: 1.1, runwayHours: 43 }), prev);

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind = ?
    `).get("vast.burn_spike") as { count: number };

    expect(row.count).toBe(0);
  });

  test("doctor decision transition emits an event", () => {
    openTempDb();

    runHomeSampler(stubHome({
      doctorLastDecision: { ts: "2026-05-10T10:00:00.000Z", slug: "story-a", action: "retry", reason: "first" },
    }));
    runHomeSampler(stubHome({
      doctorLastDecision: { ts: "2026-05-10T10:01:00.000Z", slug: "story-a", action: "kill", reason: "failed" },
    }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, entity_id, summary
      FROM events
      WHERE kind = ?
    `).all("doctor.decision") as Array<{ kind: string; severity: string; entity_id: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].entity_id).toBe("story-a");
    expect(rows[0].summary).toContain("kill");
  });

  test("doctor rate-limit increase emits a warning event", () => {
    openTempDb();

    runHomeSampler(stubHome({ doctorErrorClasses: [] }));
    runHomeSampler(stubHome({ doctorErrorClasses: [{ type: "rate_limit", count: 3 }] }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary
      FROM events
      WHERE kind = ?
    `).all("doctor.rate_limit") as Array<{ kind: string; severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].summary).toContain("0 → 3");
  });

  test("doctor quota increase emits an error event", () => {
    openTempDb();

    runHomeSampler(stubHome({ doctorErrorClasses: [] }));
    runHomeSampler(stubHome({ doctorErrorClasses: [{ type: "quota", count: 2 }] }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary
      FROM events
      WHERE kind = ?
    `).all("doctor.quota") as Array<{ kind: string; severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("0 → 2");
  });

  test("provider hot signal emits provider rate-limit event", () => {
    openTempDb();

    runHomeSampler(stubHome({ doctorRateLimitProviders: [] }));
    runHomeSampler(stubHome({
      doctorRateLimitProviders: [{
        provider: "openrouter",
        count: 4,
        models: ["openrouter/deepseek/deepseek-v3:free"],
        storySlugs: ["story-a", "story-b"],
      }],
    }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("provider.rate_limit_hot") as Array<{ severity: string; entity_id: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].entity_id).toBe("openrouter");
    expect(rows[0].summary).toContain("4 doctor entries");
    expect(JSON.parse(rows[0].payload_json).models).toContain("openrouter/deepseek/deepseek-v3:free");
  });

  test("fallback cascade signal emits model event", () => {
    openTempDb();

    runHomeSampler(stubHome({ doctorFallbackCascades: [] }));
    runHomeSampler(stubHome({
      doctorFallbackCascades: [{
        model: "editorial-cloud-heavy",
        stage: "draft",
        count: 3,
        errorType: "transport_timeout",
        storySlugs: ["story-a", "story-b", "story-c"],
      }],
    }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("model.fallback_cascade") as Array<{ severity: string; entity_id: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].entity_id).toBe("editorial-cloud-heavy");
    expect(rows[0].summary).toContain("failed 3 times");
    expect(JSON.parse(rows[0].payload_json).stage).toBe("draft");
  });

  test("heavy tier exhaustion emits model event", () => {
    openTempDb();

    runHomeSampler(stubHome({ availableByCapability: { heavy: 1, medium: 1, light: 1 } }));
    runHomeSampler(stubHome({ availableByCapability: { heavy: 0, medium: 1, light: 1 } }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, entity_id, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("model.heavy_tier_exhausted") as Array<{ severity: string; entity_id: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].entity_id).toBe("heavy");
    expect(rows[0].summary).toContain("exhausted");
    expect(JSON.parse(rows[0].payload_json).availableByCapability.heavy).toBe(0);
  });

  test("approval backlog emits a queue-health warning event", () => {
    openTempDb();

    runHomeSampler(stubHome({ approvalsWaiting: 0, queueDepth: 4, oldestApprovalAgeMs: null }));
    runHomeSampler(stubHome({ approvalsWaiting: 12, queueDepth: 14, oldestApprovalAgeMs: 30 * 60 * 1000 }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("pipeline.queue_health") as Array<{ kind: string; severity: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].summary).toContain("approval-warn");
    expect(JSON.parse(rows[0].payload_json).approvalsWaiting).toBe(12);

    const planned = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind = ?
    `).get("queue.approval_backlog") as { count: number };
    expect(planned.count).toBe(1);
  });

  test("old approval emits a critical queue-health event", () => {
    openTempDb();

    runHomeSampler(stubHome({ approvalsWaiting: 1, queueDepth: 2, oldestApprovalAgeMs: 20 * 60 * 1000 }));
    runHomeSampler(stubHome({ approvalsWaiting: 1, queueDepth: 2, oldestApprovalAgeMs: 7 * 60 * 60 * 1000 }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, summary
      FROM events
      WHERE kind = ?
    `).all("pipeline.queue_health") as Array<{ severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("approval-critical");
    expect(rows[0].summary).toContain("7h");

    const planned = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind = ?
    `).get("queue.approval_backlog") as { count: number };
    expect(planned.count).toBe(1);
  });

  test("paused queue emits a queue-health error event", () => {
    openTempDb();

    runHomeSampler(stubHome({ approvalsWaiting: 0, queueDepth: 2, paused: false }));
    runHomeSampler(stubHome({ approvalsWaiting: 0, queueDepth: 2, paused: true }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, summary
      FROM events
      WHERE kind = ?
    `).all("pipeline.queue_health") as Array<{ severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("paused-with-queue");

    const planned = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind = ?
    `).get("queue.stuck") as { count: number };
    expect(planned.count).toBe(1);
  });

  test("stage concentration emits planned queue event", () => {
    openTempDb();

    runHomeSampler(stubHome({ approvalsWaiting: 0, queueDepth: 10 }));
    runHomeSampler(stubHome({ approvalsWaiting: 0, queueDepth: 24 }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("queue.stage_concentration") as Array<{ severity: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].summary).toContain("24 queued");
    expect(JSON.parse(rows[0].payload_json).largestStage.stage).toBe("draft");
  });

  test("content health detector emits article quality findings", () => {
    openTempDb();
    const articlesRoot = join(tempDir, "articles");
    const publicRoot = join(tempDir, "public");
    mkdirSync(articlesRoot, { recursive: true });
    mkdirSync(publicRoot, { recursive: true });
    process.env.DASHBOARD_CONTENT_ARTICLES_PATH = articlesRoot;
    process.env.DASHBOARD_CONTENT_PUBLIC_PATH = publicRoot;
    process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS = "ai,finance";
    process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS = "4";

    writeArticle(articlesRoot, "bad.md", {
      title: "Bad Article",
      slug: "bad",
      status: "published",
      vertical: "unknown",
      lead: "short digest",
      digest: "short digest",
      coverImage: "/images/articles/missing.jpg",
    });

    runHomeSampler(stubHome());
    runHomeSampler(stubHome());

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, entity_id, summary, payload_json
      FROM events
      WHERE kind LIKE 'article.%'
      ORDER BY kind ASC
    `).all() as Array<{ kind: string; severity: string; entity_id: string; summary: string; payload_json: string }>;

    expect(rows.map((row) => row.kind)).toEqual([
      "article.invalid_vertical",
      "article.missing_image",
      "article.thin_digest",
    ]);
    expect(rows.every((row) => row.severity === "warn")).toBe(true);
    expect(rows.every((row) => row.entity_id === "bad")).toBe(true);
    expect(rows[0].summary).toContain("Bad Article");
    expect(JSON.parse(rows[0].payload_json).vertical).toBe("unknown");
  });

  test("content health detector skips healthy drafts and valid published articles", () => {
    openTempDb();
    const articlesRoot = join(tempDir, "articles");
    const publicRoot = join(tempDir, "public");
    const imageDir = join(publicRoot, "images", "articles");
    mkdirSync(articlesRoot, { recursive: true });
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, "ok.jpg"), "image");
    process.env.DASHBOARD_CONTENT_ARTICLES_PATH = articlesRoot;
    process.env.DASHBOARD_CONTENT_PUBLIC_PATH = publicRoot;
    process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS = "ai,finance";
    process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS = "4";

    writeArticle(articlesRoot, "ok.md", {
      title: "Good Article",
      slug: "ok",
      status: "published",
      vertical: "ai",
      lead: "The lead is intentionally different from the digest.",
      digest: "This digest has enough distinct words for the content health detector.",
      coverImage: "/images/articles/ok.jpg",
    });
    writeArticle(articlesRoot, "draft.md", {
      title: "Draft Article",
      slug: "draft",
      status: "draft",
      vertical: "",
      lead: "",
      digest: "",
      coverImage: "",
    });

    runHomeSampler(stubHome());

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind LIKE 'article.%'
    `).get() as { count: number };

    expect(row.count).toBe(0);
  });

  test("content health detector emits broken link duplicate and vertical coverage findings", () => {
    openTempDb();
    const articlesRoot = join(tempDir, "articles");
    const publicRoot = join(tempDir, "public");
    const imageDir = join(publicRoot, "images", "articles");
    mkdirSync(articlesRoot, { recursive: true });
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, "ok.jpg"), "image");
    process.env.DASHBOARD_CONTENT_ARTICLES_PATH = articlesRoot;
    process.env.DASHBOARD_CONTENT_PUBLIC_PATH = publicRoot;
    process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS = "ai,finance,space";
    process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS = "4";

    const healthyFields = {
      status: "published",
      vertical: "ai",
      lead: "The lead is intentionally different from the digest.",
      digest: "This digest has enough distinct words for the content health detector.",
      coverImage: "/images/articles/ok.jpg",
    };
    writeArticle(articlesRoot, "one.md", {
      ...healthyFields,
      title: "Shared Title",
      slug: "one",
    }, "See [missing local page](/missing-page).");
    writeArticle(articlesRoot, "two.md", {
      ...healthyFields,
      title: "Shared Title",
      slug: "two",
    });
    writeArticle(articlesRoot, "three.md", {
      ...healthyFields,
      title: "Finance Coverage",
      slug: "finance-coverage",
      vertical: "finance",
    });

    runHomeSampler(stubHome());
    runHomeSampler(stubHome());

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, entity_type, entity_id, summary, payload_json
      FROM events
      WHERE kind IN ('article.broken_link', 'content.near_duplicate', 'content.vertical_concentration', 'content.vertical_gap')
      ORDER BY kind ASC, entity_id ASC, summary ASC
    `).all() as Array<{ kind: string; severity: string; entity_type: string; entity_id: string | null; summary: string; payload_json: string }>;

    expect(rows.map((row) => row.kind)).toEqual([
      "article.broken_link",
      "content.near_duplicate",
      "content.vertical_concentration",
      "content.vertical_gap",
    ]);
    expect(rows.find((row) => row.kind === "article.broken_link")?.entity_id).toBe("one");
    expect(JSON.parse(rows.find((row) => row.kind === "article.broken_link")!.payload_json).brokenLinks).toEqual(["/missing-page"]);
    expect(rows.find((row) => row.kind === "content.near_duplicate")?.entity_id).toBe("one");
    expect(JSON.parse(rows.find((row) => row.kind === "content.near_duplicate")!.payload_json).duplicateOf).toBe("two");
    expect(JSON.parse(rows.find((row) => row.kind === "content.vertical_concentration")!.payload_json).vertical).toBe("ai");
    expect(rows.find((row) => row.kind === "content.vertical_gap")?.severity).toBe("warn");
    expect(JSON.parse(rows.find((row) => row.kind === "content.vertical_gap")!.payload_json).vertical).toBe("space");
  });
}

function openTempDb(): void {
  process.env.DASHBOARD_DB = "1";
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
}

function insertDiskSample(ts: number, diskUsedPct: number): void {
  insertHetznerSample(ts, { diskUsedPct, memUsedPct: 50 });
}

function insertVastRunwaySample(ts: number, value: { hourlyRate: number; runwayHours: number | null }): void {
  getDashboardDb()!.query(`
    INSERT INTO metric_samples (ts, source, key, value_json)
    VALUES (?, ?, ?, ?)
  `).run(ts, "vast", "runway", JSON.stringify({
    runwayHours: value.runwayHours,
    hourlyRate: value.hourlyRate,
    balance: 20,
    credit: 0,
    instanceStatus: "running",
  }));
}

function insertHetznerSample(ts: number, value: { diskUsedPct: number; memUsedPct: number }): void {
  getDashboardDb()!.query(`
    INSERT INTO metric_samples (ts, source, key, value_json)
    VALUES (?, ?, ?, ?)
  `).run(ts, "hetzner", "load", JSON.stringify({
    load1: 0.1,
    load5: 0.2,
    memUsedPct: value.memUsedPct,
    diskUsedPct: value.diskUsedPct,
  }));
}

function insertServiceSamples(service: string, states: string[]): void {
  const startTs = Date.now() - states.length * 2 * 60 * 1000;
  const statement = getDashboardDb()!.query(`
    INSERT INTO metric_samples (ts, source, key, value_json)
    VALUES (?, ?, ?, ?)
  `);

  states.forEach((state, index) => {
    statement.run(startTs + index * 60 * 1000, "services", `${service}.state`, JSON.stringify({ state }));
  });
}

function writeArticle(root: string, file: string, fields: Record<string, string>, body?: string): void {
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: "${value.replace(/"/g, '\\"')}"`)
    .join("\n");
  writeFileSync(join(root, file), `---\n${frontmatter}\n---\n\n${body ?? `Body text for ${fields.slug}.`}\n`);
}

function stubHome(overrides: {
  serviceStatus?: HomeData["services"][number]["status"];
  gpuStatus?: HomeData["gpu"]["status"];
  hourlyRate?: number | null;
  runwayHours?: number | null;
  qualitySummary?: HomeData["models"]["qualitySummary"];
  memUsedPct?: number;
  diskUsedPct?: number;
  doctorLastDecision?: HomeData["doctor"]["lastDecision"];
  doctorErrorClasses?: HomeData["doctor"]["last24h"]["errorClasses"];
  doctorRateLimitProviders?: NonNullable<HomeData["doctor"]["last24h"]["rateLimitProviders"]>;
  doctorFallbackCascades?: NonNullable<HomeData["doctor"]["last24h"]["fallbackCascades"]>;
  availableByCapability?: HomeData["models"]["availableByCapability"];
  queueDepth?: number;
  approvalsWaiting?: number;
  oldestApprovalAgeMs?: number | null;
  paused?: boolean;
} = {}): HomeData {
  const queueDepth = overrides.queueDepth ?? 2;
  const approvalsWaiting = overrides.approvalsWaiting ?? 1;
  const stageBreakdown = approvalsWaiting > 0
    ? { draft: Math.max(queueDepth - approvalsWaiting, 0), publish: approvalsWaiting }
    : { draft: queueDepth };

  return {
    services: [
      { name: "litellm", status: overrides.serviceStatus ?? "active" },
    ],
    gpu: {
      status: overrides.gpuStatus ?? "up",
      gpuUtil: 42,
      loadedModels: ["model-a"],
      probeMs: 12,
      checkedAgo: 3,
      note: null,
    },
    opencode: { reachable: true, sessionCount: 4, active24h: 2, latestUpdatedAt: Date.now() },
    vast: {
      balance: 20,
      credit: 0,
      hourlyRate: overrides.hourlyRate ?? 1,
      runwayHours: overrides.runwayHours ?? 20,
      instanceStatus: "running",
      gpu: "RTX 3090",
    },
    hetzner: {
      load1: 0.1,
      load5: 0.2,
      load15: 0.3,
      memUsedPct: overrides.memUsedPct ?? 50,
      diskUsedPct: overrides.diskUsedPct ?? 60,
    },
    newsbites: {
      totalPublished: 10,
      publishedToday: 1,
      publishedLast7d: [0, 0, 0, 0, 0, 0, 1],
      topVerticals: [],
      latestArticles: [],
      siteReachable: true,
    },
    autopipeline: {
      queueDepth,
      approvalsWaiting,
      oldestApprovalAgeMs: overrides.oldestApprovalAgeMs === undefined ? 5000 : overrides.oldestApprovalAgeMs,
      currentStory: null,
      paused: overrides.paused ?? false,
      pauseReason: null,
      stageBreakdown,
    },
    doctor: {
      last24h: {
        total: overrides.doctorErrorClasses?.reduce((sum, entry) => sum + entry.count, 0) ?? 0,
        success: 0,
        errorClasses: overrides.doctorErrorClasses ?? [],
        topFailingModels: [],
        topFailingStages: [],
        verdictMix: [],
        rateLimitProviders: overrides.doctorRateLimitProviders ?? [],
        fallbackCascades: overrides.doctorFallbackCascades ?? [],
      },
      lastDecision: overrides.doctorLastDecision ?? null,
    },
    models: {
      bestLocal: null,
      bestCloudHeavy: null,
      bestCloudFast: null,
      availableByCapability: overrides.availableByCapability ?? { heavy: 1, medium: 1, light: 1 },
      qualitySummary: overrides.qualitySummary ?? { blocked: 0, degraded: 0, probation: 0 },
      newModelsAdded: [],
      lastFullCheckAgo: 60,
      lastQuickCheckAgo: 30,
      cooldownsActive: 0,
      soonestCooldownExpiresMs: null,
    },
    incidents: {
      activeCount: 0,
      recentAlerts: [],
    },
  };
}

try {
  registerSamplerTests();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (import.meta.main && message.includes("outside of the test runner")) {
    const result = Bun.spawnSync(["bun", "test", new URL(import.meta.url).pathname], {
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(result.exitCode);
  }

  throw error;
}
