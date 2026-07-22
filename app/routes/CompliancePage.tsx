import { Fragment, useState, type FormEvent } from "react";
import { Shield, Download, FileText, Users, AlertTriangle } from "lucide-react";
import { TableControls } from "../components/TableControls";
import { useAuthApi } from "../hooks/useAuthApi";
import { useAuthStatus } from "../hooks/useAuthStatus";
import { useTableControls } from "../hooks/useTableControls";
import { authFetch } from "../lib/authFetch";

interface TenantSettings {
  tenantId: string;
  dataResidencyRegion: string;
  storageRoot: string;
  auditRetentionDays: number;
  requireTwoApprovers: boolean;
  ssoRequired: boolean;
  updatedAt: number;
}

interface ReportTemplate {
  id: string;
  name: string;
  description: string;
  params: Record<string, { type: string; required?: boolean }>;
}

type ControlStatus = "pass" | "fail" | "error" | "not-covered";

interface ComplianceControl {
  id: string;
  name: string;
  description: string;
  category: string;
  frameworkRefs: string[];
  binding:
    | { kind: "scanner"; scanner: string; failSeverity: "high" | "medium" }
    | { kind: "not-covered"; reason: string };
  status: ControlStatus | null;
  findingsCount: number;
  maxSeverity: "info" | "low" | "medium" | "high" | "critical" | null;
  lastCheckedAt: number | null;
  stale: boolean;
}

interface ComplianceControlsResult {
  controls: ComplianceControl[];
  coverage: { total: number; automated: number; notCovered: number; percent: number };
}

interface ComplianceControlHistoryRow {
  id: number;
  controlId: string;
  ts: number;
  status: ControlStatus;
  findingsCount: number;
  maxSeverity: "info" | "low" | "medium" | "high" | "critical" | null;
  evidence: string | null;
}

interface ComplianceControlHistoryResult {
  history: ComplianceControlHistoryRow[];
}

type ControlSortKey = "name" | "category" | "status" | "findings" | "lastChecked";

type ProviderDeclarationState = "undeclared" | "unreviewed" | "reviewed";
type ProviderEgressBoundary = "external-provider" | "private-network" | "unknown";
type ProviderTreatment = "accept" | "mitigate" | "transfer" | "avoid";

interface AiProviderRegisterEntry {
  key: string;
  declaration: {
    dataClasses: string[];
    credentialLocation: string | null;
    egressBoundary: ProviderEgressBoundary | null;
    owner: string | null;
    riskLikelihood: number | null;
    riskImpact: number | null;
    treatment: ProviderTreatment | null;
    lastReviewedAt: number | null;
    state: ProviderDeclarationState;
    updatedAt: number | null;
    updatedBy: string | null;
  };
  riskScore: number | null;
  evidence: {
    available: boolean;
    configuredIdentifiers: string[];
    gatewayIdentifiers: string[];
    builderIdentifiers: string[];
    gateway: {
      calls: number;
      successes: number;
      successRate: number | null;
      firstObservedAt: number | null;
      lastObservedAt: number | null;
      recentCalls: number;
      recentSuccesses: number;
      recentSuccessRate: number | null;
      recentFirstObservedAt: number | null;
      recentLastObservedAt: number | null;
    };
    builderPasses: {
      passes: number;
      successes: number;
      successRate: number | null;
      firstObservedAt: number | null;
      lastObservedAt: number | null;
    };
    routeTruthFindingKinds: Array<"dead-route" | "degraded-route" | "probe-only-route" | "broken-paid-fallback">;
    zeroSuccess17d: boolean;
  };
}

interface AiProviderRegisterPayload {
  providers: AiProviderRegisterEntry[];
}

interface RbacMe {
  role: "owner" | "operator" | "auditor" | "viewer";
  allowedActions: string[];
}

export function CompliancePage() {
  const [activeTab, setActiveTab] = useState<"controls" | "providers" | "reports" | "audit" | "tenant" | "dpa">("controls");

  return (
    <div className="dash-page">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6" style={{ color: "var(--accent)" }} />
          <h1 className="text-xl font-semibold text-[var(--text)]">Compliance</h1>
        </div>
      </div>

      <div className="dash-tabs">
        <button
          className={`tab-btn ${activeTab === "controls" ? "active" : ""}`}
          onClick={() => setActiveTab("controls")}
        >
          Controls
        </button>
        <button
          className={`tab-btn ${activeTab === "providers" ? "active" : ""}`}
          onClick={() => setActiveTab("providers")}
        >
          AI Providers
        </button>
        <button
          className={`tab-btn ${activeTab === "reports" ? "active" : ""}`}
          onClick={() => setActiveTab("reports")}
        >
          Reports
        </button>
        <button
          className={`tab-btn ${activeTab === "audit" ? "active" : ""}`}
          onClick={() => setActiveTab("audit")}
        >
          Audit Export
        </button>
        <button
          className={`tab-btn ${activeTab === "tenant" ? "active" : ""}`}
          onClick={() => setActiveTab("tenant")}
        >
          Tenant Settings
        </button>
        <button
          className={`tab-btn ${activeTab === "dpa" ? "active" : ""}`}
          onClick={() => setActiveTab("dpa")}
        >
          DPA / SOC2
        </button>
      </div>

      {activeTab === "controls" && <ControlsPanel />}
      {activeTab === "providers" && <AiProviderRegisterPanel />}
      {activeTab === "reports" && <ReportsPanel />}
      {activeTab === "audit" && <AuditExportPanel />}
      {activeTab === "tenant" && <TenantSettingsPanel />}
      {activeTab === "dpa" && <DpaPanel />}
    </div>
  );
}

function controlStatusColor(status: ControlStatus | null): string {
  switch (status) {
    case "pass": return "var(--green)";
    case "fail": return "var(--red)";
    case "error": return "var(--amber-warn)";
    case "not-covered": return "var(--text-muted)";
    default: return "var(--text-dim)";
  }
}

function controlStatusLabel(status: ControlStatus | null): string {
  return status ?? "not checked";
}

function controlStatusClass(status: ControlStatus | null): string {
  switch (status) {
    case "pass": return "green";
    case "fail": return "red";
    case "error": return "amber";
    default: return "gray";
  }
}

function formatControlTimestamp(ts: number | null): string {
  return ts === null ? "Not checked" : new Date(ts).toLocaleString();
}

function ControlsPanel() {
  const { data, loading, error, refresh } = useAuthApi<ComplianceControlsResult>("/api/compliance/controls", 0);
  const [historyByControl, setHistoryByControl] = useState<Record<string, ComplianceControlHistoryRow[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const controls = data?.controls ?? [];
  const coverage = data?.coverage;

  const table = useTableControls<ComplianceControl, ControlSortKey>({
    rows: controls,
    rowKey: (control) => control.id,
    pageSize: 25,
    defaultSort: { key: "name", dir: "asc" },
    filterText: (control) => [
      control.name,
      control.description,
      control.category,
      control.status,
      ...control.frameworkRefs,
      control.binding.kind === "scanner" ? control.binding.scanner : control.binding.reason,
    ],
    sortValue: (control, key) => {
      switch (key) {
        case "name": return control.name;
        case "category": return control.category;
        case "status": return control.status;
        case "findings": return control.findingsCount;
        case "lastChecked": return control.lastCheckedAt;
        default: return "";
      }
    },
    tieBreak: ["name"],
  });

  const loadHistory = async (controlId: string) => {
    if (historyByControl[controlId] !== undefined || historyLoading[controlId]) return;
    setHistoryLoading((current) => ({ ...current, [controlId]: true }));
    try {
      const response = await authFetch(`/api/compliance/controls/history?id=${encodeURIComponent(controlId)}&limit=10`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json() as { data?: ComplianceControlHistoryResult };
      setHistoryByControl((current) => ({ ...current, [controlId]: json.data?.history ?? [] }));
    } catch {
      setHistoryByControl((current) => ({ ...current, [controlId]: [] }));
    } finally {
      setHistoryLoading((current) => ({ ...current, [controlId]: false }));
    }
  };

  const toggleControl = (control: ComplianceControl) => {
    const opening = !table.isExpanded(control.id);
    table.toggleExpanded(control.id);
    if (opening) void loadHistory(control.id);
  };

  return (
    <div className="space-y-4">
      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)]">Control catalog</h2>
          <button className="btn btn-sm btn-ghost" onClick={refresh}>Refresh</button>
        </div>
        <div className="section-card-body compliance-section-body space-y-4">
          {coverage && (
            <div className="compliance-summary-strip">
              <Shield size={14} style={{ color: "var(--green)" }} />
              <div className="text-xs text-[var(--text)]">
                <strong>{coverage.automated} of {coverage.total} controls automated</strong> — {coverage.notCovered} honestly not covered ({coverage.percent}% coverage).
              </div>
            </div>
          )}

          {error && !data && (
            <div className="loading-panel error">Control catalog did not load: {error}</div>
          )}
          {loading && !data && <div className="loading-panel">Loading controls...</div>}

          <div className="table-container">
            <TableControls {...table.controlsProps} searchPlaceholder="Search controls..." />
            <table className="data-table">
              <thead>
                <tr>
                  <th {...table.sortHeaderProps("name")}>
                    control <span className="sortable-th-arrow">{table.sort.key === "name" ? (table.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                  </th>
                  <th {...table.sortHeaderProps("category")}>
                    category <span className="sortable-th-arrow">{table.sort.key === "category" ? (table.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                  </th>
                  <th {...table.sortHeaderProps("status")}>
                    status <span className="sortable-th-arrow">{table.sort.key === "status" ? (table.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                  </th>
                  <th {...table.sortHeaderProps("findings")}>
                    findings <span className="sortable-th-arrow">{table.sort.key === "findings" ? (table.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                  </th>
                  <th {...table.sortHeaderProps("lastChecked")}>
                    last checked <span className="sortable-th-arrow">{table.sort.key === "lastChecked" ? (table.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                  </th>
                  <th>framework refs</th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((control) => {
                  const expanded = table.isExpanded(control.id);
                  return (
                    <Fragment key={control.id}>
                      <tr>
                        <td>
                          <button className="btn btn-xs btn-ghost" onClick={() => toggleControl(control)} aria-expanded={expanded}>
                            {expanded ? "▾" : "▸"} {control.name}
                          </button>
                        </td>
                        <td className="text-xs text-[var(--text-dim)]">{control.category}</td>
                        <td>
                          <span className={`pill ${controlStatusClass(control.status)}`}>
                            {controlStatusLabel(control.status)}
                          </span>
                          {control.stale && <span className="pill amber ml-1">stale</span>}
                        </td>
                        <td className="font-mono text-xs">{control.findingsCount}</td>
                        <td className="text-xs text-[var(--text-dim)]">{formatControlTimestamp(control.lastCheckedAt)}</td>
                        <td className="text-xs text-[var(--text-dim)]">{control.frameworkRefs.join(", ")}</td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={6} className="text-xs text-[var(--text-dim)]">
                            <div className="space-y-2 py-1">
                              <div>{control.description}</div>
                              {control.binding.kind === "scanner" ? (
                                <div>Binding: <span className="font-mono">{control.binding.scanner}</span> scanner; fails at <span className="font-mono">{control.binding.failSeverity}</span> severity.</div>
                              ) : (
                                <div>Not covered: {control.binding.reason}</div>
                              )}
                              <div>
                                <span className="font-medium text-[var(--text)]">Recent history</span>
                                {historyLoading[control.id] && <span className="ml-2">Loading…</span>}
                                {!historyLoading[control.id] && (historyByControl[control.id] ?? []).length === 0 && <span className="ml-2">No recorded results yet.</span>}
                                {(historyByControl[control.id] ?? []).length > 0 && (
                                  <ul className="mt-1 space-y-1">
                                    {(historyByControl[control.id] ?? []).map((row) => (
                                      <li key={row.id}>
                                        {formatControlTimestamp(row.ts)} — <span style={{ color: controlStatusColor(row.status) }}>{row.status}</span> ({row.findingsCount} findings)
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {table.filteredCount === 0 && (
                  <tr>
                    <td colSpan={6} className="loading-dim">no controls match the current filter</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function providerStateClass(state: ProviderDeclarationState): string {
  if (state === "reviewed") return "green";
  if (state === "unreviewed") return "amber";
  return "gray";
}

function percent(value: number | null): string {
  return value === null ? "no traffic" : `${Math.round(value * 100)}%`;
}

function providerDate(value: number | null): string {
  return value ? new Date(value).toLocaleDateString() : "unreviewed";
}

function providerDateInput(value: number | null): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function AiProviderDeclarationEditor({ provider, onSaved }: { provider: AiProviderRegisterEntry; onSaved: () => void }) {
  const { declaration } = provider;
  const [editing, setEditing] = useState(false);
  const [dataClasses, setDataClasses] = useState(declaration.dataClasses.join("\n"));
  const [credentialLocation, setCredentialLocation] = useState(declaration.credentialLocation ?? "");
  const [egressBoundary, setEgressBoundary] = useState<ProviderEgressBoundary | "">(declaration.egressBoundary ?? "");
  const [owner, setOwner] = useState(declaration.owner ?? "");
  const [riskLikelihood, setRiskLikelihood] = useState(declaration.riskLikelihood?.toString() ?? "");
  const [riskImpact, setRiskImpact] = useState(declaration.riskImpact?.toString() ?? "");
  const [treatment, setTreatment] = useState<ProviderTreatment | "">(declaration.treatment ?? "");
  const [reviewDate, setReviewDate] = useState(providerDateInput(declaration.lastReviewedAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveDeclaration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const parseRisk = (value: string): number | null => value ? Number(value) : null;
    try {
      const response = await authFetch(`/api/ai-provider-register/${encodeURIComponent(provider.key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataClasses: dataClasses.split("\n").map((item) => item.trim()).filter(Boolean),
          credentialLocation: credentialLocation.trim() || null,
          egressBoundary: egressBoundary || null,
          owner: owner.trim() || null,
          riskLikelihood: parseRisk(riskLikelihood),
          riskImpact: parseRisk(riskImpact),
          treatment: treatment || null,
          lastReviewedAt: reviewDate ? Date.parse(`${reviewDate}T00:00:00.000Z`) : null,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      setEditing(false);
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>Update declaration</button>;
  }

  return (
    <form className="agent-identity-editor" onSubmit={saveDeclaration}>
      <label className="agent-identity-editor-wide">
        data classes sent (one per line)
        <textarea value={dataClasses} maxLength={5200} rows={3} onChange={(event) => setDataClasses(event.target.value)} placeholder="Undeclared" />
      </label>
      <label className="agent-identity-editor-wide">
        credential location or variable name — never secret value
        <input value={credentialLocation} maxLength={240} onChange={(event) => setCredentialLocation(event.target.value)} placeholder="process.env.PROVIDER_API_KEY" />
      </label>
      <label>
        egress boundary
        <select value={egressBoundary} onChange={(event) => setEgressBoundary(event.target.value as ProviderEgressBoundary | "")}>
          <option value="">Undeclared</option>
          <option value="external-provider">External provider</option>
          <option value="private-network">Private network</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>
      <label>
        owner
        <input value={owner} maxLength={200} onChange={(event) => setOwner(event.target.value)} placeholder="Undeclared" />
      </label>
      <label>
        likelihood (1–5)
        <select value={riskLikelihood} onChange={(event) => setRiskLikelihood(event.target.value)}>
          <option value="">Undeclared</option>
          {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>
        impact (1–5)
        <select value={riskImpact} onChange={(event) => setRiskImpact(event.target.value)}>
          <option value="">Undeclared</option>
          {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>
        treatment
        <select value={treatment} onChange={(event) => setTreatment(event.target.value as ProviderTreatment | "")}>
          <option value="">Undeclared</option>
          <option value="accept">Accept</option>
          <option value="mitigate">Mitigate</option>
          <option value="transfer">Transfer</option>
          <option value="avoid">Avoid</option>
        </select>
      </label>
      <label>
        last review
        <input type="date" value={reviewDate} onChange={(event) => setReviewDate(event.target.value)} />
      </label>
      <div className="agent-identity-editor-actions">
        <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save declaration"}</button>
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
      </div>
      {error && <div className="agent-identity-editor-error">{error}</div>}
    </form>
  );
}

function AiProviderRegisterPanel() {
  const { data, loading, error, refresh } = useAuthApi<AiProviderRegisterPayload>("/api/ai-provider-register", 15_000);
  const { data: me } = useAuthApi<RbacMe>("/api/governance/rbac/me", 60_000);
  const [expanded, setExpanded] = useState<string | null>(null);
  const canEdit = me?.role === "owner" || me?.role === "operator";

  return (
    <div className="space-y-4">
      <div className="section-card">
        <div className="section-card-header">
          <div>
            <h2 className="text-sm font-medium text-[var(--text)]">AI provider register</h2>
            <p className="text-xs text-[var(--text-dim)]">Observed provider identifiers are evidence; data-flow and risk fields are operator declarations.</p>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={refresh}>Refresh</button>
        </div>
        <div className="section-card-body compliance-section-body space-y-3">
          <div className="compliance-summary-strip">
            <Shield size={14} style={{ color: "var(--accent)" }} />
            <div className="text-xs text-[var(--text)]">Credential fields accept a location or variable name only. Secret values are never requested, displayed, or stored.</div>
          </div>
          {!canEdit && me && <div className="text-xs text-[var(--text-dim)]">Only an owner or operator can update declarations.</div>}
          {loading && !data && <div className="loading-panel">Loading observed AI providers…</div>}
          {error && !data && <div className="loading-panel error">Provider register did not load: {error}</div>}
          {data?.providers.length === 0 && <div className="empty-state">No provider identifiers have been observed in available gateway configuration or tenant telemetry.</div>}
          <div className="space-y-3">
            {(data?.providers ?? []).map((provider) => {
              const isExpanded = expanded === provider.key;
              return (
                <article key={provider.key} className="agent-identity-card">
                  <div className="agent-identity-card-head">
                    <div>
                      <div className="dash-section-title">observed provider / route identifier</div>
                      <strong className="font-mono">{provider.key}</strong>
                      <p className="text-xs text-[var(--text-dim)]">{provider.declaration.owner ?? "No owner declared"} · {provider.declaration.egressBoundary ?? "egress undeclared"}</p>
                    </div>
                    <span className={`pill ${providerStateClass(provider.declaration.state)}`}>{provider.declaration.state}</span>
                  </div>
                  <div className="agent-identity-declaration">
                    <div className="agent-identity-fields">
                      <div className="agent-identity-evidence-item"><span>risk score</span><strong>{provider.riskScore ?? "undeclared"}</strong></div>
                      <div className="agent-identity-evidence-item"><span>treatment</span><strong>{provider.declaration.treatment ?? "undeclared"}</strong></div>
                      <div className="agent-identity-evidence-item"><span>last review</span><strong>{providerDate(provider.declaration.lastReviewedAt)}</strong></div>
                    </div>
                    <div className="agent-identity-capabilities"><span>data classes sent</span><div>{provider.declaration.dataClasses.length ? provider.declaration.dataClasses.map((item) => <span className="pill gray" key={item}>{item}</span>) : <strong>undeclared</strong>}</div></div>
                  </div>
                  <div className="compliance-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => setExpanded((current) => current === provider.key ? null : provider.key)} aria-expanded={isExpanded}>{isExpanded ? "Hide evidence" : "Show evidence"}</button>
                    {canEdit && <AiProviderDeclarationEditor provider={provider} onSaved={refresh} />}
                  </div>
                  {isExpanded && (
                    <div className="agent-identity-evidence">
                      <div className="agent-identity-fields">
                        <div className="agent-identity-evidence-item"><span>gateway traffic</span><strong>{provider.evidence.available ? `${provider.evidence.gateway.successes}/${provider.evidence.gateway.calls} successful (${percent(provider.evidence.gateway.successRate)})` : "not collected"}</strong></div>
                        <div className="agent-identity-evidence-item"><span>last 17 days</span><strong>{provider.evidence.available ? `${provider.evidence.gateway.recentSuccesses}/${provider.evidence.gateway.recentCalls} successful (${percent(provider.evidence.gateway.recentSuccessRate)})` : "not collected"}</strong></div>
                        <div className="agent-identity-evidence-item"><span>builder passes</span><strong>{provider.evidence.available ? `${provider.evidence.builderPasses.successes}/${provider.evidence.builderPasses.passes} successful (${percent(provider.evidence.builderPasses.successRate)})` : "not collected"}</strong></div>
                        <div className="agent-identity-evidence-item"><span>S7 route-truth</span><strong>{provider.evidence.routeTruthFindingKinds.length ? provider.evidence.routeTruthFindingKinds.join(", ") : "none active"}</strong></div>
                      </div>
                      {provider.evidence.zeroSuccess17d && <div className="agent-identity-caveat text-xs">Reliability and governance finding: 0% success across 17 days. This is real gateway telemetry, not a diagnosis of cause.</div>}
                      <div className="agent-identity-capabilities"><span>configured identifiers</span><div>{provider.evidence.configuredIdentifiers.length ? provider.evidence.configuredIdentifiers.map((item) => <span className="pill gray" key={item}>{item}</span>) : <strong>none</strong>}</div></div>
                      <div className="agent-identity-capabilities"><span>telemetry identifiers</span><div>{[...provider.evidence.gatewayIdentifiers, ...provider.evidence.builderIdentifiers].length ? [...provider.evidence.gatewayIdentifiers, ...provider.evidence.builderIdentifiers].map((item) => <span className="pill gray" key={item}>{item}</span>) : <strong>none</strong>}</div></div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportsPanel() {
  const { data: templates, loading, error, refresh } = useAuthApi<ReportTemplate[]>("/api/reports/templates", 0);
  const { authStatus } = useAuthStatus();
  const [results, setResults] = useState<Record<string, Record<string, unknown>[]>>({});
  const [running, setRunning] = useState<string | null>(null);

  const isAuthenticated = authStatus?.authenticated || authStatus?.devBypass;

  const runReport = async (templateId: string) => {
    if (!isAuthenticated) return;
    
    setRunning(templateId);
    try {
      const res = await authFetch("/api/reports/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId,
          params: { fromTs: Date.now() - 7 * 24 * 60 * 60 * 1000, toTs: Date.now() },
        }),
      });
      const json = await res.json();
      if (json.data?.output?.rows) {
        setResults((prev) => ({ ...prev, [templateId]: json.data.output.rows }));
      }
    } finally {
      setRunning(null);
    }
  };

  if (loading && !templates) {
    return <div className="text-sm text-[var(--text-dim)]">Loading templates...</div>;
  }
  if (error && !templates) {
    return <div className="loading-panel error">Report templates did not load: {error} <button className="btn btn-sm btn-ghost" onClick={refresh}>Retry</button></div>;
  }

  return (
    <div className="space-y-4">
      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)]">Report Templates</h2>
          {!isAuthenticated && (
            <div className="text-sm text-[var(--text-dim)]">
              Authentication required to run reports
            </div>
          )}
        </div>
        <div className="section-card-body compliance-section-body">
          <div className="compliance-template-list">
          {(templates ?? []).length === 0 ? (
            <div className="empty-state">
              <FileText size={18} />
              <strong>No report templates are registered.</strong>
              <span>Templates appear here when the reporting catalog is loaded by the backend.</span>
            </div>
          ) : (templates ?? []).map((t) => (
            <div key={t.id} className="compliance-template-row">
              <div className="compliance-template-copy">
                <div className="font-medium text-sm">{t.name}</div>
                <div className="text-xs text-[var(--text-dim)]">{t.description}</div>
              </div>
              <div className="compliance-actions">
                {results[t.id] && (
                  <button
                    className="btn btn-xs btn-ghost"
                    onClick={() => {
                      const rows = results[t.id];
                      if (!rows?.length) return;
                      const headers = Object.keys(rows[0]);
                      const csv = [
                        headers.join(","),
                        ...rows.map((r) =>
                          headers.map((h) => JSON.stringify(r[h] ?? "")).join(",")
                        ),
                      ].join("\n");
                      const blob = new Blob([csv], { type: "text/csv" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `report-${t.id}.csv`;
                      a.click();
                    }}
                  >
                    Download CSV
                  </button>
                )}
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => runReport(t.id)}
                  disabled={running === t.id || !isAuthenticated}
                >
                  {running === t.id ? "…" : "Run"}
                </button>
              </div>
            </div>
          ))}
        </div>
        </div>
      </div>
    </div>
  );
}

function AuditExportPanel() {
  const { authStatus } = useAuthStatus();
  const [exporting, setExporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [chainResult, setChainResult] = useState<boolean | null>(null);
  const [dateRange, setDateRange] = useState({ from: "", to: "" });
  const [evidenceDateRange, setEvidenceDateRange] = useState(() => {
    const now = Date.now();
    return {
      from: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      to: new Date(now).toISOString().slice(0, 10),
    };
  });

  const isAuthenticated = authStatus?.authenticated || authStatus?.devBypass;

  const runExport = async () => {
    if (!isAuthenticated) return;
    
    setExporting(true);
    try {
      const res = await authFetch("/api/audit/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromTs: dateRange.from
            ? new Date(dateRange.from).getTime()
            : Date.now() - 7 * 24 * 60 * 60 * 1000,
          toTs: dateRange.to ? new Date(dateRange.to).getTime() : Date.now(),
          format: "jsonl",
        }),
      });
      const json = await res.json();
      if (json.data?.downloadUrl) {
        window.open(json.data.downloadUrl, "_blank");
      }
    } finally {
      setExporting(false);
    }
  };

  const verifyChain = async () => {
    if (!isAuthenticated) return;
    
    setVerifying(true);
    setChainResult(null);
    try {
      const res = await authFetch("/api/audit/chain-status");
      const json = await res.json();
      setChainResult(json.data?.pass ?? false);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)]">Audit Export</h2>
          {!isAuthenticated && (
            <div className="text-sm text-[var(--text-dim)]">
              Authentication required for audit operations
            </div>
          )}
        </div>
        <div className="section-card-body compliance-section-body">
          <div className="compliance-form-grid">
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">From Date</label>
              <input
                type="date"
                className="filter-input"
                value={dateRange.from}
                onChange={(e) => setDateRange((d) => ({ ...d, from: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">To Date</label>
              <input
                type="date"
                className="filter-input"
                value={dateRange.to}
                onChange={(e) => setDateRange((d) => ({ ...d, to: e.target.value }))}
              />
            </div>
          </div>
          <div className="compliance-actions">
              <button
                className="btn btn-sm btn-primary"
                onClick={runExport}
                disabled={exporting || !isAuthenticated}
              >
                {exporting ? "…" : <><Download size={14} /> Export JSONL</>}
              </button>
              <button
                className="btn btn-sm btn-secondary"
                onClick={async () => {
                  if (!isAuthenticated) return;
                  window.open("/api/compliance/evidence-bundle", "_blank");
                }}
                disabled={!isAuthenticated}
              >
                <Download size={14} /> Evidence Bundle
              </button>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  if (!isAuthenticated) return;
                  const from = new Date(`${evidenceDateRange.from}T00:00:00.000Z`).getTime();
                  const to = new Date(`${evidenceDateRange.to}T23:59:59.999Z`).getTime();
                  window.open(`/api/compliance/evidence-pack.zip?from=${from}&to=${to}`, "_blank");
                }}
                disabled={!isAuthenticated || !evidenceDateRange.from || !evidenceDateRange.to}
              >
                <Download size={14} /> Export signed evidence pack (zip)
              </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={verifyChain}
              disabled={verifying || !isAuthenticated}
            >
              {verifying ? "…" : <><Shield size={14} /> Verify Chain</>}
            </button>
            {chainResult !== null && (
              <span className={`compliance-result ${chainResult ? "ok" : "error"}`}>
                {chainResult ? "Chain integrity verified" : "Chain integrity FAILED"}
              </span>
            )}
          </div>
          <div className="compliance-form-grid">
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">Evidence pack from</label>
              <input
                type="date"
                className="filter-input"
                value={evidenceDateRange.from}
                onChange={(e) => setEvidenceDateRange((range) => ({ ...range, from: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">Evidence pack to</label>
              <input
                type="date"
                className="filter-input"
                value={evidenceDateRange.to}
                onChange={(e) => setEvidenceDateRange((range) => ({ ...range, to: e.target.value }))}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TenantSettingsPanel() {
  const { data: settings, loading, error, refresh } = useAuthApi<TenantSettings>("/api/tenant/settings", 0);
  const { authStatus } = useAuthStatus();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Partial<TenantSettings>>({});

  const isAuthenticated = authStatus?.authenticated || authStatus?.devBypass;

  const save = async () => {
    if (!isAuthenticated) return;
    
    setSaving(true);
    try {
      await authFetch("/api/tenant/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm({});
      refresh();
    } finally {
      setSaving(false);
    }
  };

  if (loading && !settings) return <div className="text-sm text-[var(--text-dim)]">Loading...</div>;
  if (error && !settings) return <div className="loading-panel error">Tenant settings did not load: {error} <button className="btn btn-sm btn-ghost" onClick={refresh}>Retry</button></div>;
  if (!settings) return <div className="empty-state"><Shield size={18} /><strong>No tenant settings returned.</strong><span>Tenant controls appear after the tenant settings table is initialized.</span></div>;

  return (
    <div className="space-y-4">
      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)]">Tenant Settings</h2>
          {!isAuthenticated && (
            <div className="text-sm text-[var(--text-dim)]">
              Authentication required to modify settings
            </div>
          )}
        </div>
        <div className="section-card-body compliance-section-body">
          <div className="compliance-form-stack">
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">Data Residency Region</label>
              <select
                className="filter-input"
                value={form.dataResidencyRegion ?? settings.dataResidencyRegion ?? "auto"}
                onChange={(e) => setForm({ ...form, dataResidencyRegion: e.target.value })}
                disabled={!isAuthenticated}
              >
                <option value="auto">Auto</option>
                <option value="us-east">US East</option>
                <option value="us-west">US West</option>
                <option value="eu-west">EU West</option>
                <option value="eu-central">EU Central</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">Storage Root</label>
              <input
                type="text"
                className="filter-input"
                value={form.storageRoot ?? settings.storageRoot ?? ""}
                onChange={(e) => setForm({ ...form, storageRoot: e.target.value })}
                disabled={!isAuthenticated}
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">Audit Retention Days</label>
              <input
                type="number"
                className="filter-input"
                value={form.auditRetentionDays ?? settings.auditRetentionDays ?? 90}
                onChange={(e) => setForm({ ...form, auditRetentionDays: parseInt(e.target.value) || 0 })}
                disabled={!isAuthenticated}
              />
            </div>
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.requireTwoApprovers ?? settings.requireTwoApprovers ?? false}
                  onChange={(e) => setForm({ ...form, requireTwoApprovers: e.target.checked })}
                  disabled={!isAuthenticated}
                />
                <span className="text-xs text-[var(--text)]">Require Two Approvers (4-Eyes)</span>
              </label>
            </div>
            <button
              className="btn btn-sm btn-primary"
              onClick={save}
              disabled={saving || !isAuthenticated}
            >
              {saving ? "…" : "Save Settings"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ComplianceSummary {
  tenantId: string;
  dataResidencyRegion: string;
  auditRetentionDays: number;
  requireTwoApprovers: boolean;
  ssoRequired: boolean;
  subprocessorCount: number;
  soc2ControlCount: number;
}

interface SubprocessorResult {
  subprocessors: string[];
}

interface Soc2MappingResult {
  mapping: Array<{ criteria: string; feature: string; notes: string }>;
}

type ComplianceSortKey = "criteria" | "feature";

function DpaPanel() {
  const { data: summary, loading: summaryLoading, error: summaryError, refresh: refreshSummary } = useAuthApi<ComplianceSummary>("/api/compliance/summary", 0);
  const { data: subproc, loading: subprocLoading, error: subprocError, refresh: refreshSubproc } = useAuthApi<SubprocessorResult>("/api/compliance/subprocessors", 0);
  const { data: mapping, loading: mappingLoading, error: mappingError, refresh: refreshMapping } = useAuthApi<Soc2MappingResult>("/api/compliance/soc2-mapping", 0);
  const { authStatus } = useAuthStatus();
  const [customerName, setCustomerName] = useState("");
  const [generating, setGenerating] = useState(false);

  const isAuthenticated = authStatus?.authenticated || authStatus?.devBypass;

  const mappingCtrl = useTableControls<{ criteria: string; feature: string; notes: string }, ComplianceSortKey>({
    rows: mapping?.mapping ?? [],
    pageSize: 25,
    filterText: (row) => [row.criteria, row.feature, row.notes],
    sortValue: (row, key) => {
      switch (key) {
        case "criteria": return row.criteria;
        case "feature": return row.feature;
        default: return "";
      }
    },
    defaultSort: { key: "criteria", dir: "asc" },
  });

  const downloadDpa = async () => {
    if (!isAuthenticated || !customerName.trim()) return;
    setGenerating(true);
    try {
      const res = await authFetch(`/api/compliance/dpa?customerName=${encodeURIComponent(customerName)}`);
      const json = await res.json();
      if (json.data?.document) {
        const blob = new Blob([json.data.document], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `DPA-${customerName}.md`;
        a.click();
      }
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)] flex items-center gap-2">
            <FileText size={14} /> DPA Document
          </h2>
          {!isAuthenticated && (
            <div className="text-sm text-[var(--text-dim)]">
              Authentication required to generate DPA documents
            </div>
          )}
        </div>
        <div className="section-card-body compliance-section-body">
          <div className="compliance-actions compliance-input-row">
            <input
              type="text"
              className="filter-input flex-1"
              placeholder="Customer name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              disabled={!isAuthenticated}
            />
            <button
              className="btn btn-sm btn-primary"
              onClick={downloadDpa}
              disabled={generating || !customerName.trim() || !isAuthenticated}
            >
              {generating ? "…" : <><Download size={14} /> Download DPA</>}
            </button>
          </div>
        </div>
      </div>

      {(summaryError || subprocError || mappingError) && (
        <div className="loading-panel error">
          Compliance evidence did not load: {summaryError ?? subprocError ?? mappingError}
          <button className="btn btn-sm btn-ghost" onClick={() => { refreshSummary(); refreshSubproc(); refreshMapping(); }}>Retry</button>
        </div>
      )}
      {(summaryLoading || subprocLoading || mappingLoading) && !summary && !subproc && !mapping && (
        <div className="loading-panel">Loading compliance evidence.</div>
      )}

      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)] flex items-center gap-2">
            <Users size={14} /> Sub-processors ({subproc?.subprocessors?.length ?? 0})
          </h2>
        </div>
        <div className="section-card-body compliance-section-body">
          {(subproc?.subprocessors ?? []).length === 0 ? (
            <div className="empty-state">
              <Users size={18} />
              <strong>No subprocessors listed.</strong>
              <span>Subprocessors appear here when the compliance template includes reviewed vendors.</span>
            </div>
          ) : (
          <ul className="text-xs space-y-1">
            {(subproc?.subprocessors ?? []).map((s: string) => (
              <li key={s} className="text-[var(--text-dim)]">{s}</li>
            ))}
          </ul>
          )}
        </div>
      </div>

      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)] flex items-center gap-2">
            <Shield size={14} /> SOC2 Control Mapping
          </h2>
        </div>
        <div className="section-card-body compliance-section-body">
          <div className="table-container">
            <TableControls {...mappingCtrl.controlsProps} searchPlaceholder="Filter controls..." />
            <table className="data-table">
              <thead>
                <tr>
                  <th {...mappingCtrl.sortHeaderProps("criteria")}>
                    criteria <span className="sortable-th-arrow">{mappingCtrl.sort.key === "criteria" ? (mappingCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                  </th>
                  <th {...mappingCtrl.sortHeaderProps("feature")}>
                    feature <span className="sortable-th-arrow">{mappingCtrl.sort.key === "feature" ? (mappingCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                  </th>
                  <th>notes</th>
                </tr>
              </thead>
              <tbody>
                {mappingCtrl.rows.map((m, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs">{m.criteria}</td>
                    <td className="text-xs">{m.feature}</td>
                    <td className="text-xs text-[var(--text-dim)]">{m.notes}</td>
                  </tr>
                ))}
                {mappingCtrl.filteredCount === 0 && (
                  <tr>
                    <td colSpan={3} className="loading-dim">no controls match the current filter</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {summary && (
        <div className="compliance-summary-strip">
          <AlertTriangle size={14} style={{ color: "var(--blue)" }} />
          <div className="text-xs text-[var(--text)]">
            Tenant: {summary.tenantId} | Region: {summary.dataResidencyRegion} |
            Retention: {summary.auditRetentionDays}d | 2FA Required:{" "}
            {summary.requireTwoApprovers ? "Yes" : "No"}
          </div>
        </div>
      )}
    </div>
  );
}
