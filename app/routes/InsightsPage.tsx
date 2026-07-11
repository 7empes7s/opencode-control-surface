import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink,
  RefreshCw, ShieldCheck, Sparkles, XCircle, Filter, X, RotateCcw,
  Activity, Database, ScanSearch, Eye, EyeOff, SlidersHorizontal,
} from "lucide-react";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";
import type { ApiEnvelope, EvidenceRef } from "../../server/api/types";
import type { Insight, InsightStatus } from "../../server/insights/types";
import { lookupInsightRunbook, type InsightRunbook } from "../../server/insights/runbooks";
import type { DiscoveredAsset, DiscoveredAssetStatus } from "../../server/discovery/reconcile";

type AiAnalysis = {
  summary: string;
  rootCause: string;
  recommendedAction: string;
  confidence: number;
  model: string;
  generatedAt: number;
};

type InsightWithAi = Insight & {
  aiAnalysis?: AiAnalysis | null;
  riskTier?: "auto" | "review" | "none";
  rollbackHint?: string | null;
};

type InsightsPayload = {
  insights: InsightWithAi[];
  openCount: number;
};

type PolicyRegistryRow = {
  key: string;
  actionDescriptorId: string | null;
  label: string;
  riskTier: "auto" | "review" | "off";
  source: "allowlist" | "reasoner" | "catalog";
  reversible: boolean;
};

type AutoApplyPreviewRow = {
  insightId: string;
  sourceKey: string;
  actionDescriptorId: string | null;
  tier: "auto" | "review" | "off" | "none";
  wouldApply: boolean;
  reason: string;
};

type StatusFilter = "open" | "applied" | "dismissed" | "resolved" | "all";

const STATUS_LABEL: Record<StatusFilter, string> = {
  open: "Open",
  applied: "Applied",
  dismissed: "Dismissed",
  resolved: "Resolved itself — verified by the scanner",
  all: "All",
};

const DOMAIN_LABEL: Record<Insight["domain"], string> = {
  cost: "Cost",
  security: "Security",
  build: "Build",
  data: "Data",
  ops: "Operations",
};

const DOMAIN_ORDER: Insight["domain"][] = ["ops", "security", "cost", "build", "data"];

const SEVERITY_RANK: Record<Insight["severity"], number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

type SeverityFilter = "all" | "critical" | "high" | "medium" | "low" | "info";
type DomainFilter = "all" | Insight["domain"];

const SAVED_FILTERS_KEY = "tib-insights-filters";

type SavedFilters = { severity: SeverityFilter; domain: DomainFilter };

function loadSavedFilters(): SavedFilters {
  try {
    const raw = localStorage.getItem(SAVED_FILTERS_KEY);
    if (!raw) return { severity: "all", domain: "all" };
    return JSON.parse(raw) as SavedFilters;
  } catch { return { severity: "all", domain: "all" }; }
}

function saveFilters(f: SavedFilters) {
  try { localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(f)); } catch { /* ignore */ }
}

function parseFocusParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("focus");
  } catch { return null; }
}

function severityClass(severity: Insight["severity"]): string {
  if (severity === "critical" || severity === "high") return "red";
  if (severity === "medium") return "amber";
  if (severity === "low") return "blue";
  return "gray";
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "high confidence";
  if (confidence >= 0.6) return "medium confidence";
  return "needs review";
}

function EvidenceDrawer({ evidenceRefs }: { evidenceRefs: EvidenceRef[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="insight-evidence">
      <button type="button" className="insight-evidence-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Evidence
      </button>
      {open && (
        <div className="insight-evidence-list">
          {evidenceRefs.length === 0 ? (
            <div className="w-caption">No evidence reference was attached.</div>
          ) : evidenceRefs.map((ref, idx) => (
            <div key={`${ref.kind}-${ref.ref}-${idx}`} className="insight-evidence-row">
              <span className="pill gray">{ref.kind}</span>
              <span>{ref.label}</span>
              <span className="dim">{ref.redacted ? "redacted" : ref.ref}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RunbookPanel({ runbook }: { runbook: InsightRunbook }) {
  return (
    <details className="insight-detector insight-runbook">
      <summary>Runbook</summary>
      <p><strong>What this means:</strong> {runbook.what}</p>
      <p><strong>What Apply does:</strong> {runbook.apply}</p>
      <p><strong>How to revert:</strong> {runbook.revert}</p>
    </details>
  );
}

// ── Auto-apply activity feed ─────────────────────────────────────────────────

type AutoFixRow = {
  id: number;
  ts: number;
  targetId: string | null;
  result: string | null;
  resultStatus: string | null;
  rollbackHint: string | null;
  risk: string | null;
  request: unknown;
};

function AutoFixActivity() {
  const { data, loading } = useApi<{ feed: AutoFixRow[]; degraded: boolean }>("/api/admin/autofixes", 30_000);
  const [reverting, setReverting] = useState<number | null>(null);
  const [revertMsg, setRevertMsg] = useState<string | null>(null);

  async function revert(row: AutoFixRow) {
    if (!row.rollbackHint) return;
    setReverting(row.id);
    setRevertMsg(null);
    try {
      const res = await authFetch("/api/actions/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: row.rollbackHint, reason: "Operator revert", confirmed: true, params: {} }),
      });
      const json = await res.json().catch(() => ({})) as { data?: { message?: string }; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Revert failed");
      setRevertMsg(json.data?.message ?? "Reverted.");
    } catch (err) {
      setRevertMsg(err instanceof Error ? err.message : "Revert could not be completed.");
    } finally {
      setReverting(null);
    }
  }

  if (loading && !data) return <div className="loading-panel">Loading auto-fix activity…</div>;
  const feed = data?.feed ?? [];

  return (
    <div className="insight-autofeed">
      {revertMsg && <div className="insights-message"><CheckCircle2 size={14} />{revertMsg}</div>}
      {feed.length === 0 ? (
        <div className="empty-state">
          <CheckCircle2 size={20} />
          <strong>No auto-fixes recorded yet.</strong>
          <span>Auto-fixes appear here when safe remediations run automatically.</span>
        </div>
      ) : (
        <div className="insight-card-list">
          {feed.map((row) => {
            const req = (row.request as Record<string, unknown>) ?? {};
            const sourceKey = typeof req.sourceKey === "string" ? req.sourceKey : null;
            const insightId = typeof req.insightId === "string" ? req.insightId : null;
            return (
              <article key={row.id} className={`insight-card severity-${row.resultStatus === "success" ? "info" : "medium"}`}>
                <div className="insight-card-head">
                  <div>
                    <div className="insight-title-row">
                      <span className={`pill ${row.resultStatus === "success" ? "green" : "red"}`}>
                        {row.resultStatus === "success" ? "Auto-applied ✓" : "Failed"}
                      </span>
                      <span className="pill gray">{row.risk ?? "low"} risk</span>
                    </div>
                    <h2>{row.result ?? "Auto-fix"}</h2>
                  </div>
                  <Activity size={18} />
                </div>
                <div className="w-caption dim">{new Date(row.ts).toLocaleString()}</div>
                {sourceKey && (
                  <div style={{ marginTop: 6 }}>
                    <Link
                      href={`/insights?focus=${encodeURIComponent(sourceKey)}`}
                      className="btn btn-ghost"
                    >
                      <ExternalLink size={13} />
                      View finding: {sourceKey}
                    </Link>
                  </div>
                )}
                {insightId && !sourceKey && (
                  <Link href={`/insights?focus=${encodeURIComponent(insightId)}`} className="btn btn-ghost">
                    <ExternalLink size={13} />
                    View finding
                  </Link>
                )}
                {row.rollbackHint && (
                  <div className="insight-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={reverting === row.id}
                      onClick={() => revert(row)}
                    >
                      <RotateCcw size={13} />
                      {reverting === row.id ? "Reverting…" : "Revert"}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AutoApplyPolicyEditor() {
  const { data, loading, error, refresh } = useApi<{ registry: PolicyRegistryRow[] }>("/api/policy/registry", 30_000);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<AutoApplyPreviewRow[] | null>(null);

  async function setTier(row: PolicyRegistryRow, tier: PolicyRegistryRow["riskTier"]) {
    setBusyKey(row.key);
    setMessage(null);
    try {
      const res = await authFetch("/api/actions/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionId: `mutate-policy:autoapply:${row.key}:set-tier`,
          confirmed: true,
          reason: "Update auto-apply policy from Detections",
          params: { tier },
        }),
      });
      const body = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMessage(body.message ?? `Policy set to ${tier}.`);
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Policy update failed.");
    } finally {
      setBusyKey(null);
    }
  }

  async function loadPreview() {
    setBusyKey("preview");
    setMessage(null);
    try {
      const res = await authFetch("/api/insights/auto-apply/preview");
      const body = await res.json().catch(() => ({})) as ApiEnvelope<{ candidates: AutoApplyPreviewRow[] }> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPreview(body.data.candidates);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setBusyKey(null);
    }
  }

  const registry = data?.registry ?? [];

  return (
    <div className="insight-autofeed">
      {message && <div className="insights-message"><CheckCircle2 size={14} />{message}</div>}
      <div className="insights-filter-bar" style={{ marginBottom: 12 }}>
        <SlidersHorizontal size={14} />
        <strong style={{ fontSize: 13 }}>Auto-apply policy</strong>
        <span className="pill gray">{registry.length} actions</span>
        <button type="button" className="btn" onClick={loadPreview} disabled={busyKey === "preview"} style={{ marginLeft: "auto", minHeight: 44 }}>
          <ScanSearch size={14} />
          {busyKey === "preview" ? "Simulating…" : "Preview auto-apply"}
        </button>
      </div>

      {preview && (
        <div className="dash-section" style={{ marginBottom: 12 }}>
          <div className="dash-section-title">dry run</div>
          {preview.length === 0 ? (
            <div className="empty-state"><ShieldCheck size={20} /><strong>No open auto-apply candidates.</strong></div>
          ) : (
            <div className="insight-card-list">
              {preview.map((row) => (
                <article key={row.insightId} className={`insight-card severity-${row.wouldApply ? "info" : "low"}`}>
                  <div className="insight-title-row">
                    <span className={`pill ${row.wouldApply ? "green" : "gray"}`}>{row.wouldApply ? "would apply" : "skip"}</span>
                    <span className="pill blue">{row.tier}</span>
                    <Link href={`/insights?focus=${encodeURIComponent(row.sourceKey)}`} className="pill gray">
                      {row.sourceKey}
                    </Link>
                  </div>
                  <p className="dim" style={{ margin: "8px 0 0" }}>{row.reason}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {loading && !data && <div className="loading-panel">Loading policy registry…</div>}
      {error && !data && <div className="loading-panel error">Policy registry did not load. Try refreshing.</div>}
      {!loading && data && registry.length === 0 && (
        <div className="empty-state">
          <ShieldCheck size={20} />
          <strong>No registered remediation actions.</strong>
        </div>
      )}
      <div className="insight-card-list">
        {registry.map((row) => (
          <article key={row.key} className="insight-card">
            <div className="insight-card-head">
              <div>
                <div className="insight-title-row">
                  <span className={`pill ${row.riskTier === "auto" ? "green" : row.riskTier === "review" ? "amber" : "gray"}`}>{row.riskTier}</span>
                  <span className="pill blue">{row.source}</span>
                  {row.reversible ? <span className="pill green">reversible</span> : <span className="pill gray">non-revertible</span>}
                </div>
                <h2>{row.label}</h2>
                <div className="mono dim" style={{ fontSize: 11, wordBreak: "break-all" }}>{row.key}</div>
              </div>
              <select
                className="select"
                value={row.riskTier}
                disabled={busyKey === row.key}
                onChange={(event) => setTier(row, event.target.value as PolicyRegistryRow["riskTier"])}
                aria-label={`Set policy for ${row.label}`}
                style={{ minHeight: 44 }}
              >
                <option value="auto">auto</option>
                <option value="review">review</option>
                <option value="off">off</option>
              </select>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

// ── AI Inventory ─────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  process: "Process",
  port: "Port/Endpoint",
  systemd: "Systemd Unit",
  container: "Container",
  backend: "Backend URL",
  cli: "CLI Tool",
  credential: "API Key",
};

const STATUS_COLOR: Record<DiscoveredAssetStatus, string> = {
  unregistered: "amber",
  registered: "green",
  ignored: "gray",
};

function ExposureBadge({ asset }: { asset: DiscoveredAsset }) {
  if (asset.kind === "port" && asset.fingerprint.exposure === "public-listener") {
    return <span className="pill red" style={{ fontSize: 10 }}>Public listener</span>;
  }
  if (asset.kind === "credential") {
    return <span className="pill amber" style={{ fontSize: 10 }}>Env key present</span>;
  }
  return null;
}

type RegisterForm = {
  name: string;
  owner: string;
  criticality: string;
  attachedService: string;
};

function AiInventory() {
  const { data, loading, error, refresh } = useApi<DiscoveredAsset[]>("/api/discovery/assets");
  const [statusFilter, setStatusFilterLocal] = useState<DiscoveredAssetStatus | "all">("all");
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [registerForm, setRegisterForm] = useState<RegisterForm>({
    name: "", owner: "", criticality: "medium", attachedService: "",
  });
  const [ignoreReason, setIgnoreReason] = useState("");
  const [pendingAction, setPendingAction] = useState<{ id: string; kind: "register" | "ignore" } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkCriticality, setBulkCriticality] = useState<NonNullable<DiscoveredAsset["criticality"]>>("medium");

  const assets = data ?? [];
  const filtered = statusFilter === "all" ? assets : assets.filter((a) => a.status === statusFilter);
  const allVisibleSelected = filtered.length > 0 && filtered.every((asset) => selectedIds.has(asset.id));

  function toggleSelected(assetId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else if (next.size < 100) next.add(assetId);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filtered.forEach((asset) => next.delete(asset.id));
      else {
        for (const asset of filtered) {
          if (next.size >= 100) break;
          next.add(asset.id);
        }
      }
      return next;
    });
  }

  async function runBulk(kind: "register" | "ignore") {
    const assetIds = [...selectedIds];
    if (assetIds.length === 0) return;
    const owner = kind === "register" ? window.prompt("Owner (optional)", "") : null;
    if (kind === "register" && owner === null) return;
    const reason = kind === "ignore" ? window.prompt("Ignore reason (optional)", "") : null;
    if (kind === "ignore" && reason === null) return;
    if (!window.confirm(`${kind === "register" ? "Register" : "Ignore"} ${assetIds.length} selected asset(s)?`)) return;

    setBusyId(`bulk-${kind}`);
    setMessage(null);
    try {
      const res = await authFetch(`/api/discovery/assets/bulk-${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetIds,
          ...(kind === "register" ? { owner: owner || undefined, criticality: bulkCriticality } : { reason: reason || undefined }),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { data?: { processed?: number; notFoundIds?: string[]; insightsResolved?: number } };
      setMessage(`${body.data?.processed ?? 0} asset(s) ${kind === "register" ? "registered" : "ignored"}. ${body.data?.insightsResolved ?? 0} insight(s) resolved.${body.data?.notFoundIds?.length ? ` ${body.data.notFoundIds.length} not found.` : ""}`);
      setSelectedIds(new Set());
      refresh();
    } catch (e) {
      setMessage(`Bulk ${kind} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function updateAsset(asset: DiscoveredAsset, changes: { owner?: string; criticality?: DiscoveredAsset["criticality"] }) {
    setBusyId(asset.id);
    setMessage(null);
    try {
      const res = await authFetch(`/api/discovery/assets/${encodeURIComponent(asset.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMessage("Asset details updated.");
      refresh();
    } catch (e) {
      setMessage(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  function editOwner(asset: DiscoveredAsset) {
    const owner = window.prompt("Asset owner (leave blank to clear)", asset.owner ?? "");
    if (owner === null || owner.trim() === (asset.owner ?? "")) return;
    void updateAsset(asset, { owner });
  }

  async function rescan() {
    setBusyId("rescan");
    setMessage(null);
    try {
      const res = await authFetch("/api/discovery/rescan", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { data?: { assetsFound?: number } };
      setMessage(`Re-scan complete — ${body.data?.assetsFound ?? 0} asset(s) found.`);
      refresh();
    } catch (e) {
      setMessage(`Re-scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function register(assetId: string) {
    setBusyId(assetId);
    setMessage(null);
    try {
      const res = await authFetch(`/api/discovery/assets/${encodeURIComponent(assetId)}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: registerForm.name || undefined,
          owner: registerForm.owner || undefined,
          criticality: registerForm.criticality || undefined,
          attachedService: registerForm.attachedService || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { data?: { insightsResolved?: number } };
      setMessage(`Asset registered. ${body.data?.insightsResolved ?? 0} insight(s) resolved.`);
      setPendingAction(null);
      setExpandedId(null);
      refresh();
    } catch (e) {
      setMessage(`Register failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function ignore(assetId: string) {
    setBusyId(assetId);
    setMessage(null);
    try {
      const res = await authFetch(`/api/discovery/assets/${encodeURIComponent(assetId)}/ignore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: ignoreReason || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { data?: { insightsResolved?: number } };
      setMessage(`Asset ignored. ${body.data?.insightsResolved ?? 0} insight(s) resolved.`);
      setPendingAction(null);
      setExpandedId(null);
      refresh();
    } catch (e) {
      setMessage(`Ignore failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  function openAction(asset: DiscoveredAsset, kind: "register" | "ignore") {
    setPendingAction({ id: asset.id, kind });
    setExpandedId(asset.id);
    if (kind === "register") {
      setRegisterForm({
        name: (asset.registeredName ?? asset.fingerprint.name ?? asset.fingerprint.unit ?? "") as string,
        owner: asset.owner ?? "",
        criticality: asset.criticality ?? "medium",
        attachedService: asset.attachedService ?? "",
      });
    } else {
      setIgnoreReason(asset.ignoredReason ?? "");
    }
  }

  function cancelAction() {
    setPendingAction(null);
    setExpandedId(null);
  }

  return (
    <div style={{ padding: "0 0 32px" }}>
      {/* ── Toolbar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>AI Inventory</span>
        <span className="pill gray" style={{ fontSize: 10 }}>{assets.length} total</span>
        <div style={{ flex: 1 }} />
        {(["all", "unregistered", "registered", "ignored"] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`filter-chip${statusFilter === s ? " active" : ""}`}
            onClick={() => setStatusFilterLocal(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
            {s !== "all" && (
              <span className={`pill ${STATUS_COLOR[s as DiscoveredAssetStatus]}`} style={{ fontSize: 9, padding: "1px 5px" }}>
                {assets.filter((a) => a.status === s).length}
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className="btn"
          disabled={busyId === "rescan"}
          onClick={rescan}
          style={{ minHeight: 44 }}
          title="Run a fresh discovery scan now"
        >
          <ScanSearch size={14} />
          {busyId === "rescan" ? "Scanning…" : "Re-scan now"}
        </button>
      </div>

      {selectedIds.size > 0 && (
        <div className="insights-message" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong>{selectedIds.size} selected (100 max)</strong>
          <select
            value={bulkCriticality}
            onChange={(event) => setBulkCriticality(event.target.value as NonNullable<DiscoveredAsset["criticality"]>)}
            aria-label="Criticality for selected assets"
            style={{ minHeight: 44 }}
          >
            <option value="low">Low criticality</option>
            <option value="medium">Medium criticality</option>
            <option value="high">High criticality</option>
            <option value="critical">Critical</option>
          </select>
          <button type="button" className="btn" disabled={busyId !== null} onClick={() => runBulk("register")} style={{ minHeight: 44 }}>
            Register selected
          </button>
          <button type="button" className="btn btn-ghost" disabled={busyId !== null} onClick={() => runBulk("ignore")} style={{ minHeight: 44 }}>
            Ignore selected
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setSelectedIds(new Set())} style={{ minHeight: 44 }}>
            Clear
          </button>
        </div>
      )}

      {message && (
        <div className="insights-message" style={{ marginBottom: 12 }}>
          <CheckCircle2 size={15} /> {message}
        </div>
      )}

      {loading && !data && <div className="loading-panel">Scanning AI inventory…</div>}
      {error && !data && <div className="loading-panel error">Could not load inventory. Try refreshing.</div>}

      {!loading && data && filtered.length === 0 && (
        <div className="empty-state">
          <Database size={24} />
          <strong>{statusFilter === "all" ? "No AI assets discovered yet." : `No ${statusFilter} assets.`}</strong>
          {statusFilter === "all" && <span>Run a scan to discover AI processes, ports, containers, CLIs, and credentials.</span>}
        </div>
      )}

      <div className="insight-card-list">
        {filtered.length > 0 && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, fontSize: 12 }}>
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
            Select all visible
          </label>
        )}
        {filtered.map((asset) => {
          const isExpanded = expandedId === asset.id;
          const action = isExpanded && pendingAction?.id === asset.id ? pendingAction.kind : null;
          const displayName = (asset.registeredName ?? asset.fingerprint.name ?? asset.fingerprint.unit ?? asset.signature) as string;

          return (
            <article key={asset.id} className={`insight-card${asset.status === "unregistered" ? " severity-medium" : ""}`} style={{ minHeight: 44 }}>
              <div className="insight-card-head">
                <input
                  type="checkbox"
                  checked={selectedIds.has(asset.id)}
                  onChange={() => toggleSelected(asset.id)}
                  aria-label={`Select ${displayName}`}
                  style={{ minWidth: 20, minHeight: 20, marginRight: 8 }}
                />
                <div>
                  <div className="insight-title-row">
                    <span className={`pill ${STATUS_COLOR[asset.status]}`} style={{ fontSize: 10 }}>{asset.status}</span>
                    <span className="pill blue" style={{ fontSize: 10 }}>{KIND_LABEL[asset.kind] ?? asset.kind}</span>
                    <ExposureBadge asset={asset} />
                    {asset.criticality && asset.status !== "registered" && (
                      <span className={`pill ${asset.criticality === "critical" || asset.criticality === "high" ? "red" : asset.criticality === "medium" ? "amber" : "gray"}`} style={{ fontSize: 10 }}>
                        {asset.criticality}
                      </span>
                    )}
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{displayName}</span>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "4px 0 0", wordBreak: "break-all" }}>
                    <span style={{ opacity: 0.7 }}>Source:</span> {asset.sourceProbe} &nbsp;·&nbsp;
                    <span style={{ opacity: 0.7 }}>Signature:</span> {asset.signature.slice(0, 80)}{asset.signature.length > 80 ? "…" : ""}
                  </p>
                  {asset.status === "registered" ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busyId === asset.id}
                        onClick={() => editOwner(asset)}
                        style={{ minHeight: 44, fontSize: 11 }}
                        title="Edit asset owner"
                      >
                        Owner: <strong>{asset.owner || "Unassigned"}</strong>
                      </button>
                      <select
                        value={asset.criticality ?? "medium"}
                        disabled={busyId === asset.id}
                        onChange={(event) => updateAsset(asset, { criticality: event.target.value as NonNullable<DiscoveredAsset["criticality"]> })}
                        aria-label={`Criticality for ${displayName}`}
                        style={{ minHeight: 44 }}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="critical">Critical</option>
                      </select>
                    </div>
                  ) : asset.owner ? <p style={{ fontSize: 11, margin: "2px 0 0" }}>Owner: <strong>{asset.owner}</strong></p> : null}
                  {asset.ignoredReason && <p style={{ fontSize: 11, margin: "2px 0 0", opacity: 0.6 }}>Ignored: {asset.ignoredReason}</p>}
                </div>
              </div>

              {/* ── Action forms ── */}
              {isExpanded && action === "register" && (
                <div style={{ padding: "12px 0 4px", borderTop: "1px solid var(--muted-border)", marginTop: 8 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <div style={{ flex: "1 1 140px" }}>
                      <label style={{ fontSize: 11, display: "block", marginBottom: 3 }}>Name</label>
                      <input
                        value={registerForm.name}
                        onChange={(e) => setRegisterForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder="e.g. Ollama local"
                        style={{ width: "100%", minHeight: 36 }}
                      />
                    </div>
                    <div style={{ flex: "1 1 120px" }}>
                      <label style={{ fontSize: 11, display: "block", marginBottom: 3 }}>Owner</label>
                      <input
                        value={registerForm.owner}
                        onChange={(e) => setRegisterForm((f) => ({ ...f, owner: e.target.value }))}
                        placeholder="team / person"
                        style={{ width: "100%", minHeight: 36 }}
                      />
                    </div>
                    <div style={{ flex: "1 1 100px" }}>
                      <label style={{ fontSize: 11, display: "block", marginBottom: 3 }}>Criticality</label>
                      <select
                        value={registerForm.criticality}
                        onChange={(e) => setRegisterForm((f) => ({ ...f, criticality: e.target.value }))}
                        style={{ width: "100%", minHeight: 36 }}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="critical">Critical</option>
                      </select>
                    </div>
                    <div style={{ flex: "1 1 140px" }}>
                      <label style={{ fontSize: 11, display: "block", marginBottom: 3 }}>Attach to service</label>
                      <input
                        value={registerForm.attachedService}
                        onChange={(e) => setRegisterForm((f) => ({ ...f, attachedService: e.target.value }))}
                        placeholder="optional"
                        style={{ width: "100%", minHeight: 36 }}
                      />
                    </div>
                  </div>
                  <div className="insight-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busyId === asset.id}
                      onClick={() => register(asset.id)}
                      style={{ minHeight: 44 }}
                    >
                      <CheckCircle2 size={14} />
                      {busyId === asset.id ? "Registering…" : "Confirm register"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={cancelAction}
                      style={{ minHeight: 44 }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {isExpanded && action === "ignore" && (
                <div style={{ padding: "12px 0 4px", borderTop: "1px solid var(--muted-border)", marginTop: 8 }}>
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ fontSize: 11, display: "block", marginBottom: 3 }}>Reason (optional)</label>
                    <input
                      value={ignoreReason}
                      onChange={(e) => setIgnoreReason(e.target.value)}
                      placeholder="e.g. dev machine only, not a managed service"
                      style={{ width: "100%", minHeight: 36 }}
                    />
                  </div>
                  <div className="insight-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busyId === asset.id}
                      onClick={() => ignore(asset.id)}
                      style={{ minHeight: 44 }}
                    >
                      <EyeOff size={14} />
                      {busyId === asset.id ? "Ignoring…" : "Confirm ignore"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={cancelAction}
                      style={{ minHeight: 44 }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* ── Per-row action buttons (when no form open) ── */}
              {!isExpanded && (
                <div className="insight-actions" style={{ paddingTop: 8 }}>
                  {asset.status !== "registered" && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => openAction(asset, "register")}
                      style={{ minHeight: 44 }}
                      title="Register this asset in the managed AI inventory"
                    >
                      <Eye size={14} />
                      Register
                    </button>
                  )}
                  {asset.status !== "ignored" && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => openAction(asset, "ignore")}
                      style={{ minHeight: 44 }}
                      title="Ignore this asset with a reason"
                    >
                      <EyeOff size={14} />
                      Ignore
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ── Main InsightsPage ────────────────────────────────────────────────────────

export function InsightsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [activeTab, setActiveTab] = useState<"inbox" | "autofeed" | "policy" | "inventory">("inbox");

  // Persistent filter chips
  const [savedFilters, setSavedFiltersState] = useState<SavedFilters>(loadSavedFilters);
  const [severityFilter, setSeverityFilterState] = useState<SeverityFilter>(savedFilters.severity);
  const [domainFilter, setDomainFilterState] = useState<DomainFilter>(savedFilters.domain);

  function setSeverityFilter(v: SeverityFilter) {
    setSeverityFilterState(v);
    const next = { severity: v, domain: domainFilter };
    setSavedFiltersState(next);
    saveFilters(next);
  }
  function setDomainFilter(v: DomainFilter) {
    setDomainFilterState(v);
    const next = { severity: severityFilter, domain: v };
    setSavedFiltersState(next);
    saveFilters(next);
  }

  const { data, loading, error, refresh } = useApi<InsightsPayload>(`/api/insights?status=${statusFilter}`, 30_000);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [bulkReasons, setBulkReasons] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  // Deep-link focus support: ?focus=<sourceKey or id>
  const focusKey = useMemo(() => parseFocusParam(), []);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const focusScrolled = useRef(false);

  useEffect(() => {
    if (!focusKey || focusScrolled.current) return;
    const el = cardRefs.current[focusKey];
    if (el) {
      focusScrolled.current = true;
      setTimeout(() => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("insight-focus-flash");
        setTimeout(() => el.classList.remove("insight-focus-flash"), 2000);
      }, 300);
    }
  }, [focusKey, data]);

  const grouped = useMemo(() => {
    const groups: Record<Insight["domain"], InsightWithAi[]> = { cost: [], security: [], build: [], data: [], ops: [] };
    for (const insight of data?.insights ?? []) {
      // Apply severity filter
      if (severityFilter !== "all" && insight.severity !== severityFilter) continue;
      // Apply domain filter
      if (domainFilter !== "all" && insight.domain !== domainFilter) continue;
      groups[insight.domain].push(insight);
    }
    for (const domain of Object.keys(groups) as Insight["domain"][]) {
      groups[domain].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.createdAt - a.createdAt);
    }
    return groups;
  }, [data, severityFilter, domainFilter]);

  async function post(path: string, body: Record<string, unknown>) {
    const res = await authFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ error: "The request did not return a readable response." })) as ApiEnvelope<unknown> & { error?: string; data?: { message?: string } };
    if (!res.ok) throw new Error(json.error || json.data?.message || "The request could not be completed.");
    return json;
  }

  async function applyInsight(insight: Insight) {
    setBusyId(insight.id);
    setMessage(null);
    try {
      const reason = (reasons[insight.id] ?? "").trim();
      const result = await post(`/api/insights/${encodeURIComponent(insight.id)}/apply`, { confirmed: true, reason });
      setMessage(result.data?.message ?? "The insight was applied and recorded.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The insight could not be applied.");
    } finally { setBusyId(null); }
  }

  async function dismissInsight(insight: Insight) {
    setBusyId(insight.id);
    setMessage(null);
    try {
      const reason = (reasons[insight.id] ?? "").trim();
      const result = await post(`/api/insights/${encodeURIComponent(insight.id)}/dismiss`, { reason });
      setMessage(result.data?.message ?? "The insight was dismissed.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The insight could not be dismissed.");
    } finally { setBusyId(null); }
  }

  async function reanalyze(insight: Insight) {
    setBusyId(`ai:${insight.id}`);
    setMessage(null);
    try {
      await post(`/api/insights/${encodeURIComponent(insight.id)}/reanalyze`, {});
      setMessage("The AI re-analysed this finding.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The finding could not be re-analysed right now.");
    } finally { setBusyId(null); }
  }

  async function scanNow() {
    setBusyId("scan");
    setMessage(null);
    try {
      await post("/api/insights/scan", {});
      setMessage("The inbox was refreshed from operations, security, cost, build, and data signals.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The scan could not be started.");
    } finally { setBusyId(null); }
  }

  async function applyGroup(domain: Insight["domain"]) {
    setBusyId(`bulk:${domain}`);
    setMessage(null);
    try {
      const result = await post("/api/insights/bulk-apply", {
        domain,
        reason: (bulkReasons[domain] ?? "").trim(),
        confirmed: true,
        mode: "autoOnly",
      });
      setMessage(result.data?.message ?? "Bulk apply finished.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Bulk apply could not be completed.");
    } finally { setBusyId(null); }
  }

  const visibleOpenInsights = useMemo(() => {
    return Object.values(grouped).flat().filter((insight) => insight.status === "open");
  }, [grouped]);

  const selectedOpenInsights = visibleOpenInsights.filter((insight) => selectedIds.has(insight.id));
  const selectedAutoCount = selectedOpenInsights.filter((insight) => insight.riskTier === "auto").length;
  const selectedReviewCount = selectedOpenInsights.filter((insight) => insight.riskTier === "review").length;

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectAllVisible(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const insight of visibleOpenInsights) {
        if (checked) next.add(insight.id);
        else next.delete(insight.id);
      }
      return next;
    });
  }

  async function bulkAck() {
    const ids = selectedOpenInsights.map((insight) => insight.id);
    if (ids.length === 0) return;
    setBusyId("bulk:ack");
    setMessage(null);
    try {
      const result = await post("/api/insights/bulk-ack", {
        ids,
        reason: "Operator acknowledged selected findings",
      });
      setMessage(result.data?.message ?? "Selected findings were acknowledged.");
      setSelectedIds(new Set());
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Bulk acknowledge could not be completed.");
    } finally { setBusyId(null); }
  }

  async function bulkSnooze(hours: number) {
    const ids = selectedOpenInsights.map((insight) => insight.id);
    if (ids.length === 0) return;
    setBusyId("bulk:snooze");
    setMessage(null);
    try {
      const result = await post("/api/insights/bulk-snooze", {
        ids,
        until: Date.now() + hours * 60 * 60_000,
        reason: `Operator snoozed selected findings for ${hours}h`,
      });
      setMessage(result.data?.message ?? "Selected findings were snoozed.");
      setSelectedIds(new Set());
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Bulk snooze could not be completed.");
    } finally { setBusyId(null); }
  }

  async function bulkApplySafe() {
    const ids = selectedOpenInsights.map((insight) => insight.id);
    if (ids.length === 0) return;
    if (!window.confirm(`Apply ${selectedAutoCount} auto-tier finding(s)? ${selectedReviewCount} review-tier finding(s) will be skipped.`)) return;
    setBusyId("bulk:apply-safe");
    setMessage(null);
    try {
      const result = await post("/api/insights/bulk-apply", {
        ids,
        reason: "Operator bulk-applied selected safe findings",
        confirmed: true,
        mode: "autoOnly",
      });
      setMessage(result.data?.message ?? "Bulk safe apply finished.");
      setSelectedIds(new Set());
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Bulk safe apply could not be completed.");
    } finally { setBusyId(null); }
  }

  async function revertInsight(insight: InsightWithAi) {
    if (!insight.rollbackHint) return;
    setBusyId(`revert:${insight.id}`);
    setMessage(null);
    try {
      const result = await post("/api/actions/execute", {
        actionId: insight.rollbackHint,
        reason: `Operator reverted applied finding ${insight.id}`,
        confirmed: true,
        params: {},
      });
      setMessage(result.data?.message ?? "The applied finding was reverted and audited.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Revert could not be completed.");
    } finally { setBusyId(null); }
  }

  const openCount = data?.openCount ?? data?.insights.length ?? 0;
  const hasActiveFilters = severityFilter !== "all" || domainFilter !== "all";

  const setCardRef = useCallback((el: HTMLElement | null, insight: InsightWithAi) => {
    cardRefs.current[insight.id] = el;
    if (insight.sourceKey) cardRefs.current[insight.sourceKey] = el;
  }, []);

  return (
    <div className="dash-page insights-page">
      <section className="insights-hero">
        <div>
          <div className="dash-section-title">admin center · detections</div>
          <h1>Detections &amp; Auto-fix</h1>
          <p>
            AI-reasoned findings sorted by severity. Safe remediations auto-apply;
            review-tier actions require one click.
          </p>
        </div>
        <div className="insights-hero-actions">
          <div className="insights-count">
            <Sparkles size={18} />
            <span>{openCount}</span>
            <small>open</small>
          </div>
          <select
            className="select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label="Filter insights by status"
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved itself — verified by the scanner</option>
            <option value="applied">Applied</option>
            <option value="dismissed">Dismissed</option>
            <option value="all">All</option>
          </select>
          <button type="button" className="btn" onClick={scanNow} disabled={busyId === "scan"}>
            <RefreshCw size={14} />
            Scan now
          </button>
        </div>
      </section>

      {/* ── Filter bar ── */}
      <div className="insights-filter-bar">
        <Filter size={13} className="dim" />
        <span className="dim" style={{ fontSize: 12 }}>Severity:</span>
        {(["all", "critical", "high", "medium", "low", "info"] as SeverityFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`filter-chip${severityFilter === s ? " active" : ""}`}
            onClick={() => setSeverityFilter(s)}
          >
            {s === "all" ? "All" : s}
          </button>
        ))}
        <span className="dim" style={{ fontSize: 12, marginLeft: 8 }}>Domain:</span>
        {(["all", "ops", "security", "cost", "build", "data"] as DomainFilter[]).map((d) => (
          <button
            key={d}
            type="button"
            className={`filter-chip${domainFilter === d ? " active" : ""}`}
            onClick={() => setDomainFilter(d)}
          >
            {d === "all" ? "All" : DOMAIN_LABEL[d as Insight["domain"]] ?? d}
          </button>
        ))}
        {hasActiveFilters && (
          <button
            type="button"
            className="filter-chip"
            title="Reset filters"
            onClick={() => { setSeverityFilter("all"); setDomainFilter("all"); }}
          >
            <X size={11} /> Reset
          </button>
        )}
      </div>

      {/* ── Tab bar ── */}
      <div className="insights-tabs">
        <button
          type="button"
          className={`insights-tab${activeTab === "inbox" ? " active" : ""}`}
          onClick={() => setActiveTab("inbox")}
        >
          <Sparkles size={13} /> Inbox
          {openCount > 0 && <span className="pill amber" style={{ fontSize: 9, padding: "1px 5px" }}>{openCount}</span>}
        </button>
        <button
          type="button"
          className={`insights-tab${activeTab === "autofeed" ? " active" : ""}`}
          onClick={() => setActiveTab("autofeed")}
        >
          <Activity size={13} /> Auto-fix Activity
        </button>
        <button
          type="button"
          className={`insights-tab${activeTab === "policy" ? " active" : ""}`}
          onClick={() => setActiveTab("policy")}
        >
          <SlidersHorizontal size={13} /> Autonomy Policy
        </button>
        <button
          type="button"
          className={`insights-tab${activeTab === "inventory" ? " active" : ""}`}
          onClick={() => setActiveTab("inventory")}
        >
          <Database size={13} /> AI Inventory
        </button>
      </div>

      {message && <div className="insights-message"><CheckCircle2 size={15} />{message}</div>}

      {activeTab === "autofeed" && <AutoFixActivity />}

      {activeTab === "policy" && <AutoApplyPolicyEditor />}

      {activeTab === "inventory" && <AiInventory />}

      {activeTab === "inbox" && (
        <>
          {loading && !data && <div className="loading-panel">Loading insights from the inbox.</div>}
          {error && !data && <div className="loading-panel error">The insights inbox did not load: {error} <button type="button" className="btn" onClick={refresh}>Retry</button></div>}

          {data && visibleOpenInsights.length > 0 && (
            <div className="insights-filter-bar" style={{ marginBottom: 12 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 44 }}>
                <input
                  type="checkbox"
                  checked={selectedOpenInsights.length > 0 && selectedOpenInsights.length === visibleOpenInsights.length}
                  onChange={(event) => selectAllVisible(event.target.checked)}
                />
                <span>{selectedOpenInsights.length} selected</span>
              </label>
              <span className="pill green">{selectedAutoCount} auto</span>
              <span className="pill amber">{selectedReviewCount} review skipped by Apply safe</span>
              <button type="button" className="btn" disabled={selectedOpenInsights.length === 0 || busyId === "bulk:ack"} onClick={bulkAck}>
                <CheckCircle2 size={14} />
                Ack
              </button>
              <button type="button" className="btn btn-ghost" disabled={selectedOpenInsights.length === 0 || busyId === "bulk:snooze"} onClick={() => bulkSnooze(24)}>
                <ShieldCheck size={14} />
                Snooze 24h
              </button>
              <button type="button" className="btn btn-primary" disabled={selectedAutoCount === 0 || busyId === "bulk:apply-safe"} onClick={bulkApplySafe}>
                <CheckCircle2 size={14} />
                Apply safe
              </button>
            </div>
          )}

          {!loading && data && data.insights.length === 0 && (
            <div className="dash-section">
              <div className="empty-state">
                <ShieldCheck size={24} />
                <strong>{statusFilter === "open" ? "No open insights right now." : `No ${STATUS_LABEL[statusFilter].toLowerCase()} insights.`}</strong>
                {statusFilter === "open" && <span>Run a scan to refresh cost, security, build, and data checks.</span>}
              </div>
            </div>
          )}

          {DOMAIN_ORDER.map((domain) => {
            const insights = grouped[domain];
            if (insights.length === 0) return null;
            const actionableCount = insights.filter((i) => i.actionDescriptorId && i.status === "open" && i.riskTier === "auto").length;
            return (
              <section className="dash-section" key={domain}>
                <div className="insight-group-title">
                  <span>{DOMAIN_LABEL[domain]}</span>
                  <span className="pill gray">{insights.length}</span>
                  <div className="insight-group-bulk">
                    <input
                      value={bulkReasons[domain] ?? ""}
                      onChange={(e) => setBulkReasons((c) => ({ ...c, [domain]: e.target.value }))}
                      placeholder="Reason for applying all"
                      aria-label={`Reason for applying all ${DOMAIN_LABEL[domain]} insights`}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={actionableCount === 0 || busyId === `bulk:${domain}`}
                      onClick={() => applyGroup(domain)}
                      title={actionableCount === 0 ? "No safe auto-tier actions in this group" : "Apply every safe auto-tier insight in this group"}
                    >
                      <CheckCircle2 size={14} />
                      Apply all safe ({actionableCount})
                    </button>
                  </div>
                </div>
                <div className="insight-card-list">
                  {insights.map((insight) => {
                    const isFocused = focusKey && (insight.id === focusKey || insight.sourceKey === focusKey);
                    const canApply = Boolean(insight.actionDescriptorId && insight.riskTier !== "none");
                    const runbook = lookupInsightRunbook({
                      domain: insight.domain,
                      actionDescriptorId: insight.actionDescriptorId,
                      sourceKey: insight.sourceKey,
                    });
                    return (
                      <article
                        key={insight.id}
                        className={`insight-card severity-${insight.severity}${isFocused ? " insight-focused" : ""}`}
                        ref={(el) => setCardRef(el, insight)}
                        id={`insight-${insight.id}`}
                      >
                        <div className="insight-card-head">
                          <div>
                            <div className="insight-title-row">
                              {insight.status === "open" && (
                                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 44 }}>
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.has(insight.id)}
                                    onChange={(event) => toggleSelected(insight.id, event.target.checked)}
                                    aria-label={`Select ${insight.title}`}
                                  />
                                  <span className="dim" style={{ fontSize: 11 }}>select</span>
                                </label>
                              )}
                              <span className={`pill ${severityClass(insight.severity)}`}>{insight.severity}</span>
                              <span className="pill blue">{confidenceLabel(insight.confidence)}</span>
                              {insight.riskTier === "auto" && insight.status === "open" && (
                                <span className="pill green" title="Safe, non-customer-facing fix — applied automatically on the next scan">Auto-fix</span>
                              )}
                              {insight.riskTier === "review" && insight.status === "open" && (
                                <span className="pill amber">Review required</span>
                              )}
                              {insight.status === "resolved" && (
                                <span className="pill green">Resolved itself — verified by the scanner</span>
                              )}
                              {insight.status === "applied" && (
                                <span className="pill green">{insight.riskTier === "auto" ? "Auto-applied ✓" : "Applied"}</span>
                              )}
                              {insight.status === "dismissed" && <span className="pill gray">Dismissed</span>}
                              {insight.acknowledgedAt && <span className="pill blue">Acknowledged</span>}
                              {insight.snoozedUntil && <span className="pill gray">Snoozed</span>}
                            </div>
                            <h2>{insight.title}</h2>
                          </div>
                          {insight.severity === "critical" || insight.severity === "high" ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}
                        </div>
                        {insight.aiAnalysis ? (
                          <div className="insight-ai">
                            <div className="insight-ai-head">
                              <Sparkles size={14} />
                              <span>AI analysis</span>
                              <span className="pill blue">{Math.round(insight.aiAnalysis.confidence * 100)}% confident</span>
                              <span className="dim">{insight.aiAnalysis.model}</span>
                            </div>
                            <p className="insight-ai-summary">{insight.aiAnalysis.summary}</p>
                            <div className="insight-ai-grid">
                              <div>
                                <span className="w-caption">Likely cause</span>
                                <p>{insight.aiAnalysis.rootCause}</p>
                              </div>
                              <div>
                                <span className="w-caption">Recommended action</span>
                                <p>{insight.aiAnalysis.recommendedAction}</p>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <p className="insight-ai-pending dim">AI analysis pending — it appears after the next scan.</p>
                        )}
                        <details className="insight-detector">
                          <summary>Detector signal</summary>
                          <p>{insight.plainSummary}</p>
                        </details>
                        <RunbookPanel runbook={runbook} />
                        <EvidenceDrawer evidenceRefs={insight.evidenceRefs} />
                        {insight.sourceKey && (
                          <div className="insight-source-key">
                            <span className="dim" style={{ fontSize: 11 }}>source key:</span>
                            <Link href={`/insights?focus=${encodeURIComponent(insight.sourceKey)}`} className="pill gray" style={{ fontSize: 11 }}>
                              {insight.sourceKey}
                            </Link>
                          </div>
                        )}
                        {insight.status === "open" ? (
                          <>
                            <div className="insight-reason-row">
                              <input
                                value={reasons[insight.id] ?? ""}
                                onChange={(event) => setReasons((current) => ({ ...current, [insight.id]: event.target.value }))}
                                placeholder="Reason for applying or dismissing"
                                aria-label={`Reason for ${insight.title}`}
                              />
                            </div>
                            <div className="insight-actions">
                              <button
                                type="button"
                                className="btn"
                                disabled={!canApply || busyId === insight.id}
                                onClick={() => applyInsight(insight)}
                                title={canApply ? "Apply this audited action" : "This action is disabled by policy or needs manual handling"}
                              >
                                <CheckCircle2 size={14} />
                                Apply
                              </button>
                              <Link href={insight.manualPageHref} className="btn btn-ghost">
                                <ExternalLink size={14} />
                                Configure manually
                              </Link>
                              <button type="button" className="btn btn-ghost" disabled={busyId === insight.id} onClick={() => dismissInsight(insight)}>
                                <XCircle size={14} />
                                Dismiss
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={busyId === `ai:${insight.id}`}
                                onClick={() => reanalyze(insight)}
                                title="Ask the AI to re-analyse this finding now"
                              >
                                <Sparkles size={14} />
                                {busyId === `ai:${insight.id}` ? "Analysing…" : "Re-analyze"}
                              </button>
                            </div>
                          </>
                        ) : insight.status === "applied" ? (
                          <div className="insight-actions">
                            {insight.rollbackHint ? (
                              <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={busyId === `revert:${insight.id}`}
                                onClick={() => revertInsight(insight)}
                              >
                                <RotateCcw size={14} />
                                {busyId === `revert:${insight.id}` ? "Reverting…" : "Revert"}
                              </button>
                            ) : (
                              <span className="pill gray">Not reversible</span>
                            )}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
