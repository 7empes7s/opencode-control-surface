import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDashboardDb,
  getDashboardDb,
  initDashboardDb,
  SEED_DEFAULT_TENANT_ID,
  SEED_DEFAULT_TENANT_NAME,
  SETUP_COMPLETED_MARKER_KEY,
  SETUP_PENDING_MARKER_KEY,
} from "../db/dashboard.ts";
import { computeNeedsSetup, setupCompleteHandler, setupStateHandler } from "./setup.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "setup-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function post(body: unknown): Request {
  return new Request("http://127.0.0.1:3000/api/setup/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Turn the hermetic fresh DB into a faithful stand-in for THIS production
// host's database: it was created by a build that predates the first-run
// feature, so it has no setup.pending marker (and no setup.completed either)
// — while its tenant row still literally carries the seed-default name.
function simulatePreExistingInstall(): void {
  getDashboardDb()!.query(`DELETE FROM system_configs WHERE key = ?`).run(SETUP_PENDING_MARKER_KEY);
}

describe("setup state — fresh install", () => {
  test("a brand-new database is born with the setup.pending marker and no completed marker", () => {
    const db = getDashboardDb()!;
    const pending = db.query(`SELECT value_json FROM system_configs WHERE key = ?`).get(SETUP_PENDING_MARKER_KEY) as { value_json: string } | null;
    expect(pending).not.toBeNull();
    expect(JSON.parse(pending!.value_json).firstBootAt).toBeGreaterThan(0);
    const completed = db.query(`SELECT 1 FROM system_configs WHERE key = ?`).get(SETUP_COMPLETED_MARKER_KEY);
    expect(completed).toBeNull();
  });

  test("needsSetup is true on a brand-new, never-completed database", () => {
    expect(computeNeedsSetup()).toBe(true);
  });

  test("GET handler wraps the state in the standard API envelope", async () => {
    const res = setupStateHandler();
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: { needsSetup?: boolean } };
    expect(body.data?.needsSetup).toBe(true);
  });

  // The server autonomously writes rows on every boot (ingestor ->
  // metric_samples, insights scanner -> insights, demo seeds -> showcase
  // tenants). None of that is operator activity, and none of it may hide the
  // wizard on a genuinely fresh install.
  test("needsSetup stays true after background machinery writes rows (ingestor/insights/demo seeds)", () => {
    const db = getDashboardDb()!;
    db.query(`INSERT INTO metric_samples (ts, source, key, value_json, tenant_id) VALUES (?, ?, ?, ?, ?)`)
      .run(Date.now(), "edge", "vast.runway", "{}", SEED_DEFAULT_TENANT_ID);
    db.query(`
      INSERT INTO insights (id, domain, severity, title, plain_summary, confidence, evidence_refs_json, manual_page_href, status, tenant_id, created_at)
      VALUES (?, 'ops', 'high', ?, ?, 0.7, '[]', '/insights', 'open', ?, ?)
    `).run("insight_ops_boot", "GPU unavailable", "Boot-time scanner finding.", SEED_DEFAULT_TENANT_ID, Date.now());
    db.query(`INSERT INTO action_audit (ts, action_kind, action, risk, tenant_id) VALUES (?, ?, ?, ?, ?)`)
      .run(Date.now(), "builder.workflow.start", "builder.workflow.start", "low", "showcase-demo");

    expect(computeNeedsSetup()).toBe(true);
  });

  test("POST complete renames the seed tenant, writes the marker, audits, and flips needsSetup false", async () => {
    const res = await setupCompleteHandler(post({ tenantName: "Acme Corp" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: { ok?: boolean; tenantName?: string } };
    expect(body.data?.ok).toBe(true);
    expect(body.data?.tenantName).toBe("Acme Corp");

    const db = getDashboardDb()!;
    const tenant = db.query(`SELECT name FROM tenants WHERE id = ?`).get(SEED_DEFAULT_TENANT_ID) as { name: string };
    expect(tenant.name).toBe("Acme Corp");

    const marker = db.query(`SELECT value_json FROM system_configs WHERE key = ?`).get(SETUP_COMPLETED_MARKER_KEY) as { value_json: string } | null;
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker!.value_json).tenantName).toBe("Acme Corp");

    expect(computeNeedsSetup()).toBe(false);

    const audit = db.query(`SELECT action_kind, risk, target_id FROM action_audit WHERE action_kind = ?`).get("setup.complete") as
      { action_kind: string; risk: string; target_id: string } | null;
    expect(audit).not.toBeNull();
    expect(audit!.risk).toBe("low");
    expect(audit!.target_id).toBe(SEED_DEFAULT_TENANT_ID);
  });

  test("POST complete rejects a missing tenantName", async () => {
    const res = await setupCompleteHandler(post({}));
    expect(res.status).toBe(400);
    expect(computeNeedsSetup()).toBe(true);
  });

  test("POST complete rejects a blank tenantName", async () => {
    const res = await setupCompleteHandler(post({ tenantName: "   " }));
    expect(res.status).toBe(400);
  });

  test("needsSetup flips false if the tenant was renamed through another path (no wizard nag)", () => {
    const db = getDashboardDb()!;
    db.query(`UPDATE tenants SET name = ? WHERE id = ?`).run("Renamed Elsewhere", SEED_DEFAULT_TENANT_ID);
    expect(computeNeedsSetup()).toBe(false);
  });
});

describe("setup state — existing populated install (predates this feature)", () => {
  // THE critical constraint: this production host's database was created long
  // before the first-run wizard existed, its tenant is still literally named
  // MIMULE, and it has no marker rows of either kind. needsSetup must be
  // false there — deploying this feature must never resurface the wizard on
  // an install that is already in use.
  test("needsSetup is false when the DB predates the feature (no pending marker), even with the seed-default tenant name", () => {
    simulatePreExistingInstall();

    const db = getDashboardDb()!;
    const tenant = db.query(`SELECT name FROM tenants WHERE id = ?`).get(SEED_DEFAULT_TENANT_ID) as { name: string };
    expect(tenant.name).toBe(SEED_DEFAULT_TENANT_NAME); // sanity: still the literal seed default

    expect(computeNeedsSetup()).toBe(false);
  });

  test("re-running migrations on an existing DB does not re-create the pending marker", () => {
    simulatePreExistingInstall();

    // Re-open the same file: initDashboardDb runs migrateDashboardDb again,
    // exactly like a production service restart after deploying this feature.
    closeDashboardDb();
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });

    const db = getDashboardDb()!;
    const pending = db.query(`SELECT 1 FROM system_configs WHERE key = ?`).get(SETUP_PENDING_MARKER_KEY);
    expect(pending).toBeNull();
    expect(computeNeedsSetup()).toBe(false);
  });

  test("needsSetup is false where the DB already has a renamed tenant and a completed marker", async () => {
    await setupCompleteHandler(post({ tenantName: "Long-Standing Install" }));

    // Service restart on that install:
    closeDashboardDb();
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });

    const db = getDashboardDb()!;
    const tenant = db.query(`SELECT name FROM tenants WHERE id = ?`).get(SEED_DEFAULT_TENANT_ID) as { name: string };
    expect(tenant.name).toBe("Long-Standing Install");
    expect(computeNeedsSetup()).toBe(false);

    const res = setupStateHandler();
    const body = await res.json() as { data?: { needsSetup?: boolean } };
    expect(body.data?.needsSetup).toBe(false);
  });
});
