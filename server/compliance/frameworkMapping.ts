import type { TenantContext } from "../tenancy/context.ts";
import {
  listCatalogControls,
  type CatalogControl,
  type ControlStatus,
} from "./controls.ts";
import {
  ISO_42001_ANNEX_A_REFERENCE_BY_ID,
  ISO_42001_ANNEX_A_REFERENCE_INDEX,
  type Iso42001AnnexAReferenceClause,
} from "./iso42001AnnexA.ts";

export const ISO_42001_ANNEX_A_REF_PREFIX = "ISO 42001 Annex ";

export type FrameworkMappedControl = Pick<
  CatalogControl,
  "id" | "name" | "status" | "findingsCount" | "maxSeverity" | "lastCheckedAt" | "stale" | "binding"
>;

export type FrameworkClauseMapping = {
  clause: Iso42001AnnexAReferenceClause;
  controls: FrameworkMappedControl[];
  status: ControlStatus | null;
};

export type FrameworkMappingCoverage = {
  referenceClauseCount: number;
  mappedClauseCount: number;
  unmappedClauseCount: number;
  mappedControlCount: number;
};

export type FrameworkMapping = {
  framework: {
    id: "iso-iec-42001-annex-a";
    name: "ISO/IEC 42001:2023 Annex A";
    referenceIndexLabel: "Annex A reference index (static, code-maintained)";
  };
  mappedClauses: FrameworkClauseMapping[];
  unmappedClauses: Iso42001AnnexAReferenceClause[];
  coverage: FrameworkMappingCoverage;
};

const STATUS_RANK: Record<ControlStatus, number> = {
  pass: 1,
  "not-covered": 2,
  fail: 3,
  error: 4,
};

export function iso42001AnnexAClauseIds(frameworkRefs: readonly string[]): string[] {
  return frameworkRefs.flatMap((frameworkRef) => {
    if (!frameworkRef.startsWith(ISO_42001_ANNEX_A_REF_PREFIX)) return [];
    const id = frameworkRef.slice(ISO_42001_ANNEX_A_REF_PREFIX.length).trim();
    return id ? [id] : [];
  });
}

export function rollupFrameworkStatus(controls: readonly Pick<FrameworkMappedControl, "status">[]): ControlStatus | null {
  let worst: ControlStatus | null = null;
  for (const control of controls) {
    if (control.status === null) continue;
    if (worst === null || STATUS_RANK[control.status] > STATUS_RANK[worst]) {
      worst = control.status;
    }
  }
  return worst;
}

function frameworkMappedControl(control: CatalogControl): FrameworkMappedControl {
  return {
    id: control.id,
    name: control.name,
    status: control.status,
    findingsCount: control.findingsCount,
    maxSeverity: control.maxSeverity,
    lastCheckedAt: control.lastCheckedAt,
    stale: control.stale,
    binding: control.binding,
  };
}

export function listFrameworkMapping(now = Date.now(), ctx?: TenantContext): FrameworkMapping {
  const { controls } = listCatalogControls(now, ctx);
  const controlsByClause = new Map<string, FrameworkMappedControl[]>();

  for (const control of controls) {
    for (const clauseId of iso42001AnnexAClauseIds(control.frameworkRefs)) {
      if (!ISO_42001_ANNEX_A_REFERENCE_BY_ID.has(clauseId)) continue;
      const mappedControls = controlsByClause.get(clauseId) ?? [];
      mappedControls.push(frameworkMappedControl(control));
      controlsByClause.set(clauseId, mappedControls);
    }
  }

  const mappedClauses: FrameworkClauseMapping[] = [];
  const unmappedClauses: Iso42001AnnexAReferenceClause[] = [];
  for (const clause of ISO_42001_ANNEX_A_REFERENCE_INDEX) {
    const mappedControls = controlsByClause.get(clause.id);
    if (!mappedControls) {
      unmappedClauses.push(clause);
      continue;
    }
    mappedClauses.push({
      clause,
      controls: mappedControls,
      status: rollupFrameworkStatus(mappedControls),
    });
  }

  return {
    framework: {
      id: "iso-iec-42001-annex-a",
      name: "ISO/IEC 42001:2023 Annex A",
      referenceIndexLabel: "Annex A reference index (static, code-maintained)",
    },
    mappedClauses,
    unmappedClauses,
    coverage: {
      referenceClauseCount: ISO_42001_ANNEX_A_REFERENCE_INDEX.length,
      mappedClauseCount: mappedClauses.length,
      unmappedClauseCount: unmappedClauses.length,
      mappedControlCount: new Set(mappedClauses.flatMap((clause) => clause.controls.map((control) => control.id))).size,
    },
  };
}
