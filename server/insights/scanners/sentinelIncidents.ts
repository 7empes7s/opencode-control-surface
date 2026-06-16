import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDashboardDb, isDashboardDbEnabled } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";
import { dispatchEventFireAndForget } from "../../webhooks/dispatcher.ts";

const DEFAULT_SENTINEL_HEALTH_PATH = "/var/lib/mimule/product-health.json";

type Finding = {
  id?: string;
  name?: string;
  status?: string;
  severity?: string;
  detail?: string;
};

type SentinelCard = {
  findings?: Finding[];
  checkedAt?: number;
  checkedAtISO?: string;
  score?: number;
  fails?: number;
  warns?: number;
  agents?: Record<string, { ok?: boolean }>;
};

type ScanResult = {
  scannedAt: number;
  scanned: number;
  createdOrUpdated: number;
  deduped: number;
};

function getSentinelHealthPath(): string {
  return process.env.SENTINEL_HEALTH_PATH ?? DEFAULT_SENTINEL_HEALTH_PATH;
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function impactRank(findingId: string): "high" | "medium" {
  if (findingId === "/" || findingId.startsWith("page/")) return "high";
  return "medium";
}

function mapSeverity(raw: string | undefined): "critical" | "high" | "medium" | "low" {
  const v = String(raw ?? "").toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high") return "high";
  if (v === "warn" || v === "warning" || v === "medium") return "medium";
  return "low";
}

function clusterKeyFor(findingId: string, dayStart: number): string {
  return createHash("sha256").update(`sentinel|${findingId}|${dayStart}`).digest("hex");
}

function readSentinelCard(): SentinelCard | null {
  try {
    return JSON.parse(readFileSync(getSentinelHealthPath(), "utf8")) as SentinelCard;
  } catch {
    return null;
  }
}

export function runSentinelIncidentScan(): ScanResult {
  const scannedAt = Date.now();
  if (!isDashboardDbEnabled()) return { scannedAt, scanned: 0, createdOrUpdated: 0, deduped: 0 };

  const db = getDashboardDb();
  if (!db) return { scannedAt, scanned: 0, createdOrUpdated: 0, deduped: 0 };

  const card = readSentinelCard();
  if (!card) return { scannedAt, scanned: 0, createdOrUpdated: 0, deduped: 0 };

  const findings = Array.isArray(card.findings) ? card.findings : [];
  const fails = findings.filter((f) => String(f.status ?? "") === "fail");
  if (fails.length === 0) return { scannedAt, scanned: 0, createdOrUpdated: 0, deduped: 0 };

  const seenAtMs = typeof card.checkedAt === "number"
    ? card.checkedAt * 1000
    : scannedAt;
  const dayStart = startOfUtcDay(seenAtMs);
  const tenant = whereTenant();
  const tenantId = tenant.params[0];

  let createdOrUpdated = 0;
  let deduped = 0;

  for (const finding of fails) {
    const findingId = String(finding.id ?? "").trim();
    if (!findingId) continue;

    const severityTag = mapSeverity(finding.severity);
    const rank = impactRank(findingId);
    const key = clusterKeyFor(findingId, dayStart);
    const rawName = String(finding.name ?? findingId).slice(0, 80) || findingId;
    const title = `[${severityTag}/${rank}] ${rawName}`;
    const failureClass = "sentinel_health";
    const representativePassId = `sentinel:${safeId(findingId)}`;

    const existing = db.query(`
      SELECT id FROM reasoner_incidents
      WHERE cluster_key = ?
      LIMIT 1
    `).get(key) as { id: string } | null;

    if (existing) {
      db.query(`
        UPDATE reasoner_incidents
        SET last_seen = ?, occurrence_count = occurrence_count + 1, status = 'open'
        WHERE id = ?
      `).run(seenAtMs, existing.id);
      deduped += 1;
      continue;
    }

    const incidentId = `ri_${randomUUID()}`;
    db.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'open', ?)
    `).run(
      incidentId,
      key,
      failureClass,
      title,
      seenAtMs,
      seenAtMs,
      representativePassId,
      representativePassId,
      tenantId,
    );
    createdOrUpdated += 1;
    // Phase G: fire-and-forget webhook for new sentinel incidents
    try {
      dispatchEventFireAndForget("incident.created", {
        incidentId,
        title,
        severity: severityTag,
        failureClass,
        firstSeen: seenAtMs,
        findingId,
      });
    } catch { /* never throw out of scan path */ }
  }

  return { scannedAt, scanned: fails.length, createdOrUpdated, deduped };
}
