import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDashboardDb,
  getDashboardDb,
  initDashboardDb,
} from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  buildEvidencePackInMemory,
  buildEvidencePackV2,
  generateEvidencePack,
  readEvidencePackById,
} from "./evidencePack.ts";
import { buildEvidenceZip, crc32, verifyEvidenceZip } from "./zipPack.ts";

const SECRET_VALUE = "supersecret-token-DO-NOT-LEAK-9f3a";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "evidence-pack-test-"));
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

function withTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

function seedAuditRows(tenantId: string, n: number): void {
  withTenant(tenantId, () => {
    for (let i = 0; i < n; i++) {
      writeActionAudit({
        userId: `user-${i}`,
        actor: `actor-${i}`,
        actorSource: "test",
        actionKind: `test.action.${i}`,
        targetType: "test-target",
        targetId: `tgt-${i}`,
        risk: "low",
        resultStatus: "success",
        resultJson: { note: SECRET_VALUE, index: i },
      });
    }
  });
}

function seedUserWithRole(id: string, email: string, role: string): void {
  const db = getDashboardDb()!;
  const now = Date.now();
  db.query(
    `INSERT OR REPLACE INTO users (id, email, name, auth_method, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, email, email, "local", now, "mimule");
  db.query(
    `INSERT OR REPLACE INTO governance_role_bindings (id, user_id, role, project_id, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(`binding-${id}`, id, role, null, now);
}

function seedGatewayKey(id: string, agentId: string, hash: string): void {
  const db = getDashboardDb()!;
  const now = Date.now();
  db.query(
    `INSERT OR REPLACE INTO gateway_keys (id, agent_id, name, key_hash, model_allowlist, status, created_at, last_used_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, agentId, `key-${id}`, hash, "", "active", now, now, "mimule");
}

function seedChainedAuditRows(
  tenantId: string,
  timestamps: number[],
): Array<{ id: number; rowHash: string }> {
  const db = getDashboardDb()!;
  let previousHash = "genesis";
  const seeded: Array<{ id: number; rowHash: string }> = [];
  const insert = db.query(`
    INSERT INTO action_audit
      (ts, actor, action_kind, target_type, target_id, result_status, tenant_id, prev_hash, row_hash)
    VALUES (?, ?, ?, 'test-target', ?, 'success', ?, ?, ?)
  `);
  db.transaction(() => {
    timestamps.forEach((ts, index) => {
      const rowHash = `hash-${index}`;
      const result = insert.run(
        ts,
        `actor-${index}`,
        `test.chain.${index}`,
        `target-${index}`,
        tenantId,
        previousHash,
        rowHash,
      );
      seeded.push({ id: Number(result.lastInsertRowid), rowHash });
      previousHash = rowHash;
    });
  })();
  return seeded;
}

function seedIncident(input: {
  id: string;
  tenantId: string;
  lastSeen: number;
  resolvedAt: number | null;
  postMortem: string | null;
}): void {
  const db = getDashboardDb()!;
  db.query(`
    INSERT INTO reasoner_incidents
      (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
       representative_pass_id, representative_diagnosis_id, status, tenant_id,
       resolved_at, post_mortem)
    VALUES (?, ?, 'test-failure', ?, ?, ?, 1, ?, ?, 'resolved', ?, ?, ?)
  `).run(
    input.id,
    `cluster-${input.id}`,
    `Incident ${input.id}`,
    input.lastSeen - 100,
    input.lastSeen,
    `pass-${input.id}`,
    `diagnosis-${input.id}`,
    input.tenantId,
    input.resolvedAt,
    input.postMortem,
  );
}

function readSigningKey(): Buffer {
  const row = getDashboardDb()!.query(
    `SELECT value_json FROM operator_state WHERE key = 'evidence_signing_key'`,
  ).get() as { value_json: string } | null;
  expect(row).not.toBeNull();
  const parsed = JSON.parse(row!.value_json) as { keyHex: string };
  return Buffer.from(parsed.keyHex, "hex");
}

describe("evidencePack", () => {
  it("generates a pack and persists a report_archive row", () => {
    const { id } = withTenant("mimule", () => generateEvidencePack());
    expect(id).not.toBe("db-off");
    expect(id).toMatch(/^\d+$/);

    const db = getDashboardDb()!;
    const row = db
      .query(
        `SELECT id, kind, path, summary FROM report_archive WHERE kind = 'evidence-pack'`,
      )
      .get() as { id: number; kind: string; path: string; summary: string | null } | null;

    expect(row).not.toBeNull();
    expect(row!.kind).toBe("evidence-pack");
    expect(row!.path).toContain("compliance/evidence-pack/");
    expect(row!.summary).toBeTruthy();

    const stored = JSON.parse(row!.summary!) as {
      tenant: string;
      auditChain: { rows: unknown[]; chainSha256: string };
      accessReview: { users: unknown[]; gatewayKeys: unknown[] };
      trustScore: { score: number; maxScore: number };
      counts: { insights: number; action_audit: number; cost_events: number };
    };
    expect(stored.tenant).toBe("mimule");
    expect(stored.trustScore.maxScore).toBe(100);
    expect(stored.counts.action_audit).toBeGreaterThanOrEqual(0);
  });

  it("readEvidencePackById returns the stored JSON for the returned id", () => {
    const { id } = withTenant("mimule", () => generateEvidencePack());
    const pack = withTenant("mimule", () => readEvidencePackById(id));
    expect(pack).not.toBeNull();
    expect(pack!.id).toBe(id);
    expect(pack!.tenant).toBe("mimule");
    expect(pack!.auditChain.chainSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("readEvidencePackById returns null for unknown id", () => {
    const pack = withTenant("mimule", () => readEvidencePackById("999999"));
    expect(pack).toBeNull();
  });

  it("chainSha256 is deterministic for the same redacted rows", () => {
    seedAuditRows("mimule", 3);
    const a = withTenant("mimule", () => buildEvidencePackInMemory());
    const b = withTenant("mimule", () => buildEvidencePackInMemory());
    expect(a.chainSha256).toBe(b.chainSha256);
    expect(a.chainSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("chainSha256 changes when audit rows change", () => {
    seedAuditRows("mimule", 2);
    const a = withTenant("mimule", () => buildEvidencePackInMemory());
    seedAuditRows("mimule", 1);
    const b = withTenant("mimule", () => buildEvidencePackInMemory());
    expect(a.chainSha256).not.toBe(b.chainSha256);
  });

  it("redacts audit rows to {ts, actor, action, target_type, target_id, result_status}", () => {
    seedAuditRows("mimule", 1);
    const { pack } = withTenant("mimule", () => buildEvidencePackInMemory());
    expect(pack.auditChain.rows.length).toBeGreaterThan(0);
    for (const row of pack.auditChain.rows) {
      const keys = Object.keys(row).sort();
      expect(keys).toEqual(
        ["action", "actor", "result_status", "target_id", "target_type", "ts"],
      );
    }
  });

  it("never leaks secrets from action_audit into the accessReview", () => {
    seedAuditRows("mimule", 2);
    seedUserWithRole("u-1", "ops@example.com", "owner");
    seedGatewayKey("k-1", "agent-alpha", SECRET_VALUE);

    const { pack } = withTenant("mimule", () => buildEvidencePackInMemory());
    const json = JSON.stringify(pack.accessReview);
    expect(json).not.toContain(SECRET_VALUE);
    expect(json).not.toContain("supersecret-token-DO-NOT-LEAK");

    for (const key of pack.accessReview.gatewayKeys) {
      const keyJson = JSON.stringify(key);
      expect(keyJson).not.toContain(SECRET_VALUE);
      expect(Object.keys(key).sort()).toEqual(
        ["agent_id", "id", "last_used_at", "status"],
      );
    }
  });

  it("returns db-off sentinel when DB is disabled", () => {
    closeDashboardDb();
    const { id } = withTenant("mimule", () => generateEvidencePack());
    expect(id).toBe("db-off");
  });

  it("builds the V2 period sections from real sources with honest empty model lifecycle", () => {
    const periodStart = 10_000;
    const periodEnd = 20_000;
    const auditRows = seedChainedAuditRows("mimule", [9_000, 11_000, 12_000, 21_000]);
    seedIncident({
      id: "pm-in-last-seen",
      tenantId: "mimule",
      lastSeen: 15_000,
      resolvedAt: null,
      postMortem: "Recovered during the evidence period.",
    });
    seedIncident({
      id: "pm-in-resolved",
      tenantId: "mimule",
      lastSeen: 25_000,
      resolvedAt: 16_000,
      postMortem: "Resolved during the evidence period.",
    });
    seedIncident({
      id: "pm-out",
      tenantId: "mimule",
      lastSeen: 25_000,
      resolvedAt: 25_000,
      postMortem: "Outside the evidence period.",
    });
    seedIncident({
      id: "pm-null",
      tenantId: "mimule",
      lastSeen: 15_000,
      resolvedAt: 15_000,
      postMortem: null,
    });

    const db = getDashboardDb()!;
    db.query(`
      INSERT INTO discovered_assets
        (id, tenant_id, kind, signature, source_probe, first_seen, last_seen, status,
         fingerprint_json, registered_name, owner, criticality, updated_at)
      VALUES
        ('asset-1', 'mimule', 'backend', 'model-api', 'test', 1, 19000, 'registered',
         '{}', 'Model API', 'platform', 'high', 19000),
        ('asset-2', 'mimule', 'cli', 'codex', 'test', 1, 18000, 'ignored',
         '{"name":"Codex CLI"}', NULL, NULL, NULL, 18000)
    `).run();

    const pack = withTenant("mimule", () => buildEvidencePackV2(periodStart, periodEnd));
    expect(pack.period).toEqual({ from: periodStart, to: periodEnd });
    expect(pack.auditChainSegment.configured).toBe(true);
    if (pack.auditChainSegment.configured) {
      expect(pack.auditChainSegment.rows.map((row) => row.ts)).toEqual([11_000, 12_000]);
      expect(pack.auditChainSegment.chainVerification).toEqual({
        ok: true,
        brokenAt: null,
        checkedCount: 2,
      });
      expect(pack.auditChainSegment.rows.some((row) => row.ts === 9_000 || row.ts === 21_000)).toBe(false);
    }
    expect(auditRows).toHaveLength(4);
    expect(pack.controlStatuses).toMatchObject({ configured: true, tenantId: "mimule" });
    expect(pack.modelLifecycle).toEqual({ configured: false });
    expect(pack.postmortems).toEqual({
      configured: true,
      records: [
        {
          id: "pm-in-last-seen",
          title: "Incident pm-in-last-seen",
          failureClass: "test-failure",
          resolvedAt: null,
          postMortem: "Recovered during the evidence period.",
        },
        {
          id: "pm-in-resolved",
          title: "Incident pm-in-resolved",
          failureClass: "test-failure",
          resolvedAt: 16_000,
          postMortem: "Resolved during the evidence period.",
        },
      ],
    });
    expect(pack.discoveryInventory).toEqual({
      configured: true,
      assets: [
        {
          id: "asset-1",
          kind: "backend",
          name: "Model API",
          status: "registered",
          criticality: "high",
          owner: "platform",
          lastSeen: 19_000,
        },
        {
          id: "asset-2",
          kind: "cli",
          name: "Codex CLI",
          status: "ignored",
          criticality: null,
          owner: null,
          lastSeen: 18_000,
        },
      ],
      countsByStatus: { registered: 1, ignored: 1 },
    });
  });

  it("caps the audit segment at 2000 rows and reports the cap", () => {
    const periodStart = 10_000;
    const periodEnd = 20_000;
    seedChainedAuditRows("mimule", [
      9_000,
      ...Array.from({ length: 2001 }, (_, index) => 10_000 + index),
      21_000,
    ]);

    const pack = withTenant("mimule", () => buildEvidencePackV2(periodStart, periodEnd));
    expect(pack.auditChainSegment.configured).toBe(true);
    if (pack.auditChainSegment.configured) {
      expect(pack.auditChainSegment.cap).toBe(2000);
      expect(pack.auditChainSegment.capped).toBe(true);
      expect(pack.auditChainSegment.rows).toHaveLength(2000);
      expect(pack.auditChainSegment.rows.every((row) => row.ts >= periodStart && row.ts <= periodEnd)).toBe(true);
      expect(pack.auditChainSegment.chainVerification).toEqual({
        ok: true,
        brokenAt: null,
        checkedCount: 2000,
      });
    }
  });

  it("surfaces the unchanged real chain verifier result for a broken segment link", () => {
    const seeded = seedChainedAuditRows("mimule", [11_000, 12_000]);
    getDashboardDb()!.query(`UPDATE action_audit SET prev_hash = 'tampered-link' WHERE id = ?`)
      .run(seeded[1].id);

    const pack = withTenant("mimule", () => buildEvidencePackV2(10_000, 20_000));
    expect(pack.auditChainSegment.configured).toBe(true);
    if (pack.auditChainSegment.configured) {
      expect(pack.auditChainSegment.chainVerification).toEqual({
        ok: false,
        brokenAt: seeded[1].id,
        checkedCount: 1,
      });
    }
  });

  it("includes grounded model-eval lifecycle records when present", () => {
    const db = getDashboardDb()!;
    db.query(`INSERT INTO metric_samples (ts, source, key, value_json, tenant_id)
      VALUES (?, 'model-eval', ?, ?, 'mimule')`)
      .run(15_000, "candidate-model", JSON.stringify({ ts: 15_000, score: 0.91, latencyMs: 85 }));

    const pack = withTenant("mimule", () => buildEvidencePackV2(10_000, 20_000));
    expect(pack.modelLifecycle).toEqual({
      configured: true,
      records: [{
        logicalName: "candidate-model",
        firstSeen: 15_000,
        lastEval: 15_000,
        evalHistory: [{ ts: 15_000, score: 0.91, latencyMs: 85, error: null }],
      }],
    });
  });

  it("builds and verifies a signed STORE-only ZIP", () => {
    const zip = withTenant("mimule", () => buildEvidenceZip(10_000, 20_000));
    const verification = verifyEvidenceZip(zip, readSigningKey());
    expect(zip.length).toBeGreaterThan(0);
    expect(verification).toMatchObject({ ok: true, errors: [] });
    expect(verification.manifest?.entries.map((entry) => entry.name)).toEqual(["pack.json"]);
  });

  it("detects a corrupted pack.json byte by CRC and SHA-256", () => {
    const zip = withTenant("mimule", () => buildEvidenceZip(10_000, 20_000));
    const corrupted = Buffer.from(zip);
    const marker = corrupted.indexOf(Buffer.from('"tenant": "mimule"', "utf8"));
    expect(marker).toBeGreaterThan(0);
    corrupted[marker + 12] ^= 1;

    const verification = verifyEvidenceZip(corrupted, readSigningKey());
    expect(verification.ok).toBe(false);
    expect(verification.errors).toContain("CRC-32 mismatch for pack.json");
    expect(verification.errors).toContain("SHA-256 mismatch for pack.json");
  });

  it("rejects the ZIP with the wrong HMAC key", () => {
    const zip = withTenant("mimule", () => buildEvidenceZip(10_000, 20_000));
    const verification = verifyEvidenceZip(zip, randomBytes(32));
    expect(verification.ok).toBe(false);
    expect(verification.errors).toContain("Signing key fingerprint mismatch");
    expect(verification.errors).toContain("HMAC signature mismatch");
  });

  it("matches the standard CRC-32 known vector", () => {
    expect(crc32("123456789")).toBe(0xcbf43926);
  });
});
