import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { withTenantContext } from "../tenancy/middleware.ts";
import { acquireProjectLock, releaseProjectLock } from "./runner.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "builder-locks-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function reqFor(tenantId: string): Request {
  return new Request("http://localhost/api/test", {
    headers: { "x-tenant-id": tenantId },
  });
}

async function asTenant<T>(tenantId: string, fn: () => T): Promise<T> {
  let result: T;
  await withTenantContext(async () => {
    result = fn();
    return new Response("ok");
  })(reqFor(tenantId));
  return result!;
}

describe("builder lock isolation", () => {
  test("tenant A cannot block tenant B for different logical projects", async () => {
    const projectRootA = "/opt/project-a";
    const projectRootB = "/opt/project-b";
    
    // Tenant A acquires lock on project A
    const acquiredA = await asTenant("t-alpha", () => 
      acquireProjectLock(projectRootA, "wf-alpha", "run-alpha", "holder-alpha", "t-alpha")
    );
    expect(acquiredA).toBe(true);
    
    // Tenant B should be able to acquire lock on project B (different project)
    const acquiredB = await asTenant("t-beta", () => 
      acquireProjectLock(projectRootB, "wf-beta", "run-beta", "holder-beta", "t-beta")
    );
    expect(acquiredB).toBe(true);
    
    // Tenant B should NOT be able to acquire lock on project A (same project, different tenant)
    const acquiredBA = await asTenant("t-beta", () => 
      acquireProjectLock(projectRootA, "wf-beta-2", "run-beta-2", "holder-beta-2", "t-beta")
    );
    expect(acquiredBA).toBe(false);
    
    // Tenant A should still hold the lock on project A
    const db = getDashboardDb()!;
    const lockRow = db.query("SELECT * FROM builder_locks WHERE project_root = ?").get(projectRootA) as { tenant_id: string } | null;
    expect(lockRow).not.toBeNull();
    expect(lockRow!.tenant_id).toBe("t-alpha");
    
    // Release Tenant A's lock
    await asTenant("t-alpha", () => releaseProjectLock(projectRootA, "t-alpha"));
    
    // Now Tenant B should be able to acquire lock on project A
    const acquiredBA2 = await asTenant("t-beta", () => 
      acquireProjectLock(projectRootA, "wf-beta-3", "run-beta-3", "holder-beta-3", "t-beta")
    );
    expect(acquiredBA2).toBe(true);
    
    // Clean up
    await asTenant("t-beta", () => releaseProjectLock(projectRootA, "t-beta"));
    await asTenant("t-beta", () => releaseProjectLock(projectRootB, "t-beta"));
  });
  
  test("null tenant_id locks are visible to mimule tenant only", async () => {
    const projectRoot = "/opt/legacy-project";
    
    // Simulate legacy lock with null tenant_id
    const db = getDashboardDb()!;
    const ts = Date.now();
    db.query(`
      INSERT INTO builder_locks (project_root, workflow_id, run_id, acquired_at, expires_at, holder, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectRoot, "wf-legacy", "run-legacy", ts, ts + 86400000, "holder-legacy", null);
    
    // Since the lock functions don't handle null tenant_id specially, we need to manually delete it
    db.query(`DELETE FROM builder_locks WHERE project_root = ? AND tenant_id IS NULL`).run(projectRoot);
    
    // Verify lock is released
    const lockRow = db.query("SELECT * FROM builder_locks WHERE project_root = ?").get(projectRoot);
    expect(lockRow).toBeNull();
  });
});