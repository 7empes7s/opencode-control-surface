import { useState } from "react";
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

export function CompliancePage() {
  const [activeTab, setActiveTab] = useState<"reports" | "audit" | "tenant" | "dpa">("reports");

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

      {activeTab === "reports" && <ReportsPanel />}
      {activeTab === "audit" && <AuditExportPanel />}
      {activeTab === "tenant" && <TenantSettingsPanel />}
      {activeTab === "dpa" && <DpaPanel />}
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
