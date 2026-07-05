import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { DiagnosisResult } from "./types.ts";
import { computeSlaDueAt } from "./sla.ts";

function normalizeClusterPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function computeClusterKey(failureClass: string, rootCauseHypothesis: string): string {
  const normalized = [
    normalizeClusterPart(failureClass),
    normalizeClusterPart(rootCauseHypothesis),
  ].join(":");
  return createHash("sha256").update(normalized).digest("hex");
}

export function clusterDiagnosis(db: Database, diagnosis: DiagnosisResult): string {
  const clusterKey = computeClusterKey(diagnosis.failureClass, diagnosis.rootCauseHypothesis);
  const now = Date.now();
  const seenAt = diagnosis.diagnosedAt || now;

  const diagnosisRow = db.query(`
    SELECT id FROM reasoner_diagnoses
    WHERE pass_id = ?
    ORDER BY diagnosed_at DESC
    LIMIT 1
  `).get(diagnosis.passId) as { id: string } | null;
  const diagnosisId = diagnosisRow?.id ?? `rd_missing_${randomUUID()}`;

  const existing = db.query(`
    SELECT id FROM reasoner_incidents
    WHERE cluster_key = ?
    LIMIT 1
  `).get(clusterKey) as { id: string } | null;

  const incidentId = existing?.id ?? `ri_${randomUUID()}`;

  if (existing) {
    db.query(`
      UPDATE reasoner_incidents
      SET last_seen = ?, occurrence_count = occurrence_count + 1
      WHERE id = ?
    `).run(seenAt, incidentId);
  } else {
    const title = diagnosis.rootCauseHypothesis.trim().slice(0, 80) || diagnosis.failureClass;
    db.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status, sla_due_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'open', ?)
    `).run(
      incidentId,
      clusterKey,
      diagnosis.failureClass,
      title,
      seenAt,
      seenAt,
      diagnosis.passId,
      diagnosisId,
      computeSlaDueAt(title, seenAt),
    );
  }

  db.query(`
    INSERT INTO reasoner_incident_members (id, incident_id, pass_id, diagnosis_id, added_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(`rim_${randomUUID()}`, incidentId, diagnosis.passId, diagnosisId, now);

  return incidentId;
}
