import { getDashboardDb } from "../db/dashboard.ts";
import { listPlaybooks } from "../reasoner/playbooks.ts";
import { actionCatalogHandler } from "./actionDescriptors.ts";
import { ok, type ActionDescriptor, type ApiEnvelope } from "./types.ts";
import {
  COOLDOWN_CLEAR_POLICY_KEY,
  SAFE_AUTO_ACTIONS,
  tierForRegistryKey,
  type AutoApplyTier,
} from "../insights/autoapplyPolicy.ts";

export type PolicyRegistrySource = "allowlist" | "reasoner" | "catalog";

export interface PolicyRegistryRow {
  key: string;
  actionDescriptorId: string | null;
  label: string;
  riskTier: AutoApplyTier;
  source: PolicyRegistrySource;
  reversible: boolean;
}

type CatalogEnvelope = ApiEnvelope<{ actions: ActionDescriptor[] }>;

function addRow(rows: Map<string, PolicyRegistryRow>, row: Omit<PolicyRegistryRow, "riskTier">): void {
  const existing = rows.get(row.key);
  if (existing) {
    rows.set(row.key, {
      ...existing,
      source: existing.source === row.source ? existing.source : existing.source,
      actionDescriptorId: existing.actionDescriptorId ?? row.actionDescriptorId,
      label: existing.label || row.label,
      reversible: existing.reversible || row.reversible,
      riskTier: tierForRegistryKey(row.key, existing.actionDescriptorId ?? row.actionDescriptorId),
    });
    return;
  }
  rows.set(row.key, {
    ...row,
    riskTier: tierForRegistryKey(row.key, row.actionDescriptorId),
  });
}

async function listCatalogActions(): Promise<ActionDescriptor[]> {
  try {
    const response = await actionCatalogHandler(new URL("http://localhost/api/actions/catalog"));
    const body = await response.json() as CatalogEnvelope;
    return body.data.actions ?? [];
  } catch {
    return [];
  }
}

export async function buildPolicyRegistry(): Promise<PolicyRegistryRow[]> {
  const rows = new Map<string, PolicyRegistryRow>();

  for (const actionId of SAFE_AUTO_ACTIONS) {
    addRow(rows, {
      key: actionId,
      actionDescriptorId: actionId,
      label: actionId,
      source: "allowlist",
      reversible: false,
    });
  }
  addRow(rows, {
    key: COOLDOWN_CLEAR_POLICY_KEY,
    actionDescriptorId: COOLDOWN_CLEAR_POLICY_KEY,
    label: "Clear model cooldown",
    source: "allowlist",
    reversible: false,
  });

  const db = getDashboardDb();
  if (db) {
    try {
      for (const playbook of listPlaybooks(db)) {
        const actionDescriptorId = `reasoner-remediate:${playbook.id}`;
        addRow(rows, {
          key: actionDescriptorId,
          actionDescriptorId,
          label: playbook.name,
          source: "reasoner",
          reversible: false,
        });
      }
    } catch {
      // Registry remains useful from allowlist + catalog if playbooks are absent.
    }
  }

  for (const action of await listCatalogActions()) {
    addRow(rows, {
      key: action.id,
      actionDescriptorId: action.id,
      label: action.label,
      source: "catalog",
      reversible: Boolean(action.rollbackHint && action.rollbackHint.includes(":")),
    });
  }

  return [...rows.values()].sort((a, b) => a.source.localeCompare(b.source) || a.label.localeCompare(b.label));
}

export async function isKnownPolicyRegistryKey(key: string): Promise<boolean> {
  const rows = await buildPolicyRegistry();
  return rows.some((row) => row.key === key);
}

export async function policyRegistryHandler(): Promise<Response> {
  const registry = await buildPolicyRegistry();
  return Response.json(ok({ registry }));
}
