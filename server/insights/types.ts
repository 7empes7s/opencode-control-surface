import type { EvidenceRef } from "../api/types.ts";

export type InsightDomain = "cost" | "security" | "build" | "data" | "ops";
export type InsightStatus = "open" | "applied" | "dismissed" | "resolved";
export type InsightSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface Insight {
  id: string;
  domain: InsightDomain;
  severity: InsightSeverity;
  title: string;
  plainSummary: string;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  actionDescriptorId: string | null;
  manualPageHref: string;
  status: InsightStatus;
  tenant_id: string;
  createdAt: number;
  resolvedAt?: number | null;
  resolution?: string | null;
  sourceKey?: string | null;
  acknowledgedAt?: number | null;
  snoozedUntil?: number | null;
}

export type InsightInput = Omit<Insight, "status" | "tenant_id"> & {
  status?: InsightStatus;
  tenant_id?: string;
  sourceKey?: string;
};
