import { useState } from "react";
import { Shield, Download, FileText, Users, AlertTriangle } from "lucide-react";
import { useApi } from "../hooks/useApi";

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
  const { data: templates } = useApi<ReportTemplate[]>("/api/reports/templates", 0);
  const [results, setResults] = useState<Record<string, Record<string, unknown>[]>>({});
  const [running, setRunning] = useState<string | null>(null);

  const runReport = async (templateId: string) => {
    setRunning(templateId);
    try {
      const res = await fetch("/api/reports/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId,
          params: { tenantId: "mimule", fromTs: Date.now() - 7 * 24 * 60 * 60 * 1000, toTs: Date.now() },
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

  if (!templates) {
    return <div className="text-sm text-[var(--text-dim)]">Loading templates...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)]">Report Templates</h2>
          <div className="space-y-3">
            {templates.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium text-sm">{t.name}</div>
                  <div className="text-xs text-[var(--text-dim)]">{t.description}</div>
                </div>
                <div className="flex items-center gap-2">
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
                    disabled={running === t.id}
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
  const [exporting, setExporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [chainResult, setChainResult] = useState<boolean | null>(null);
  const [dateRange, setDateRange] = useState({ from: "", to: "" });

  const runExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/audit/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: "mimule",
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
    setVerifying(true);
    setChainResult(null);
    try {
      const res = await fetch("/api/audit/chain-status");
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
          <div className="grid grid-cols-2 gap-4">
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
          <div className="flex gap-2">
            <button
              className="btn btn-sm btn-primary"
              onClick={runExport}
              disabled={exporting}
            >
              {exporting ? "…" : <><Download size={14} /> Export JSONL</>}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={verifyChain}
              disabled={verifying}
            >
              {verifying ? "…" : <><Shield size={14} /> Verify Chain</>}
            </button>
            {chainResult !== null && (
              <span style={{ fontSize: 12, color: chainResult ? "var(--green)" : "var(--red)", alignSelf: "center" }}>
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
  const { data: settings, refresh } = useApi<TenantSettings>("/api/tenant/settings", 0);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Partial<TenantSettings>>({});

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/tenant/settings", {
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

  if (!settings) return <div className="text-sm text-[var(--text-dim)]">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)]">Tenant Settings</h2>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">Data Residency Region</label>
              <select
                className="filter-input"
                value={form.dataResidencyRegion ?? settings.dataResidencyRegion ?? "auto"}
                onChange={(e) => setForm({ ...form, dataResidencyRegion: e.target.value })}
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
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">Audit Retention Days</label>
              <input
                type="number"
                className="filter-input"
                value={form.auditRetentionDays ?? settings.auditRetentionDays ?? 90}
                onChange={(e) => setForm({ ...form, auditRetentionDays: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.requireTwoApprovers ?? settings.requireTwoApprovers ?? false}
                  onChange={(e) => setForm({ ...form, requireTwoApprovers: e.target.checked })}
                />
                <span className="text-xs text-[var(--text)]">Require Two Approvers (4-Eyes)</span>
              </label>
            </div>
            <button
              className="btn btn-sm btn-primary"
              onClick={save}
              disabled={saving}
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

function DpaPanel() {
  const { data: summary } = useApi<ComplianceSummary>("/api/compliance/summary", 0);
  const { data: subproc } = useApi<SubprocessorResult>("/api/compliance/subprocessors", 0);
  const { data: mapping } = useApi<Soc2MappingResult>("/api/compliance/soc2-mapping", 0);
  const [customerName, setCustomerName] = useState("");
  const [generating, setGenerating] = useState(false);

  const downloadDpa = async () => {
    if (!customerName.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/compliance/dpa?customerName=${encodeURIComponent(customerName)}`);
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
          <div className="flex gap-2">
            <input
              type="text"
              className="filter-input flex-1"
              placeholder="Customer name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
            />
            <button
              className="btn btn-sm btn-primary"
              onClick={downloadDpa}
              disabled={generating || !customerName.trim()}
            >
              {generating ? "…" : <><Download size={14} /> Download DPA</>}
            </button>
          </div>
        </div>
      </div>

      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)] flex items-center gap-2">
            <Users size={14} /> Sub-processors ({subproc?.subprocessors?.length ?? 0})
          </h2>
          <ul className="text-xs space-y-1">
            {(subproc?.subprocessors ?? []).map((s: string) => (
              <li key={s} className="text-[var(--text-dim)]">{s}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="section-card">
        <div className="section-card-header">
          <h2 className="text-sm font-medium text-[var(--text)] flex items-center gap-2">
            <Shield size={14} /> SOC2 Control Mapping
          </h2>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Criteria</th>
                  <th>Feature</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {(mapping?.mapping ?? []).map((m, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs">{m.criteria}</td>
                    <td className="text-xs">{m.feature}</td>
                    <td className="text-xs text-[var(--text-dim)]">{m.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {summary && (
        <div style={{ background: "color-mix(in oklch, var(--blue) 8%, transparent)", border: "1px solid color-mix(in oklch, var(--blue) 30%, transparent)", borderRadius: 6, padding: "12px 14px", display: "flex", alignItems: "center", gap: 8 }}>
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