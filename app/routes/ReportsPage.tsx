import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Download, FileDown, FileText, Play, RefreshCw, Upload } from "lucide-react";
import { TableControls } from "../components/TableControls";
import { useApi } from "../hooks/useApi";
import { useAuthStatus } from "../hooks/useAuthStatus";
import { useTableControls } from "../hooks/useTableControls";
import { authFetch } from "../lib/authFetch";
import type { ReportRun, ReportTemplate } from "../../server/reporting/types";

type ReportSummaryRow = {
  templateId: string;
  status: string;
  count: number;
  latestStartedAt: number;
};

type ReportsArchiveResponse = {
  runs: ReportRun[];
  templates: ReportTemplate[];
  summary: ReportSummaryRow[];
};

type RangePreset = "24h" | "7d" | "30d";
type ExportFormat = "pdf" | "pptx" | "docx";

const EXPORT_LABELS: Record<ExportFormat, string> = {
  pdf: "PDF",
  pptx: "PowerPoint",
  docx: "Word",
};

const RANGE_MS: Record<RangePreset, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function formatDate(ts: number | null | undefined): string {
  if (!ts) return "pending";
  return new Date(ts).toLocaleString();
}

function formatPeriod(run: ReportRun): string | null {
  const params = run.params as { fromTs?: number; toTs?: number } | undefined;
  if (!params || typeof params.fromTs !== "number" || typeof params.toTs !== "number") return null;
  return `${new Date(params.fromTs).toLocaleDateString()} → ${new Date(params.toTs).toLocaleDateString()}`;
}

function statusClass(status: string): string {
  if (status === "success") return "green";
  if (status === "failed") return "red";
  if (status === "running") return "amber";
  return "gray";
}

function rowsFromOutput(output: unknown): Record<string, unknown>[] {
  if (!output || typeof output !== "object") return [];
  const rows = (output as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
}

function makeMarkdown(run: ReportRun, templateName: string): string {
  const rows = rowsFromOutput(run.output);
  const title = `# ${templateName} report`;
  const meta = [
    `- Run: ${run.id}`,
    `- Status: ${run.status}`,
    `- Started: ${formatDate(run.startedAt)}`,
    `- Finished: ${formatDate(run.finishedAt)}`,
    `- Rows: ${run.rowCount}`,
  ].join("\n");

  if (!rows.length) return `${title}\n\n${meta}\n\nNo rows.`;

  const headers = Object.keys(rows[0]).slice(0, 8);
  const headerLine = `| ${headers.join(" |")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.slice(0, 20).map((row) =>
    `| ${headers.map((header) => String(row[header] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`
  ).join("\n");
  const truncated = rows.length > 20 ? `\n\nShowing 20 of ${rows.length} rows.` : "";

  return `${title}\n\n${meta}\n\n${headerLine}\n${divider}\n${body}${truncated}`;
}

function ReportPreview({ run }: { run: ReportRun }) {
  const rows = rowsFromOutput(run.output);
  if (run.error) {
    return <div className="reports-run-error"><AlertTriangle size={14} />{run.error}</div>;
  }
  if (!rows.length) {
    return <span className="dim">No rows stored for this run.</span>;
  }

  const keys = Object.keys(rows[0]).slice(0, 4);
  return (
    <div className="reports-row-preview">
      {keys.map((key) => (
        <span key={key}>
          <strong>{key}</strong>
          {String(rows[0][key] ?? "none")}
        </span>
      ))}
    </div>
  );
}

export function ReportsPage() {
  const { data, loading, error, refresh } = useApi<ReportsArchiveResponse>("/api/reports?limit=100", 30_000);
  const { authStatus } = useAuthStatus();
  const [templateId, setTemplateId] = useState("daily-pipeline");
  const [range, setRange] = useState<RangePreset>("7d");
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [exportingDoc, setExportingDoc] = useState<{ id: string; format: ExportFormat } | null>(null);
  const [exportDocError, setExportDocError] = useState<{ id: string; message: string } | null>(null);

  const templates = data?.templates ?? [];
  const runs = data?.runs ?? [];
  const summary = data?.summary ?? [];
  const isAuthenticated = authStatus?.authenticated || authStatus?.devBypass;

  const templateNames = useMemo(() => {
    return new Map(templates.map((template) => [template.id, template.name]));
  }, [templates]);

  const visibleRuns = useTableControls<ReportRun, "startedAt">({
    rows: runs,
    pageSize: 12,
    defaultSort: { key: "startedAt", dir: "desc" },
    filterText: (run) => [
      run.id,
      run.templateId,
      templateNames.get(run.templateId),
      run.status,
      run.error,
    ],
    sortValue: (run) => run.startedAt,
  });

  const totals = useMemo(() => {
    return {
      total: runs.length,
      success: runs.filter((run) => run.status === "success").length,
      failed: runs.filter((run) => run.status === "failed").length,
      rows: runs.reduce((sum, run) => sum + (run.rowCount ?? 0), 0),
    };
  }, [runs]);

  const generateReport = async () => {
    if (!isAuthenticated || running) return;
    setRunning(true);
    setMessage(null);
    const toTs = Date.now();
    const fromTs = toTs - RANGE_MS[range];

    try {
      const response = await authFetch("/api/reports/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, params: { fromTs, toTs } }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
      setMessage(`Generated ${templateNames.get(templateId) ?? templateId}.`);
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const downloadCsv = async (run: ReportRun) => {
    setDownloadingId(run.id);
    setMessage(null);
    try {
      const response = await authFetch(`/api/reports/${run.id}/csv`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `report-${run.templateId}-${run.id}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingId(null);
    }
  };

  const downloadDocExport = async (run: ReportRun, format: ExportFormat) => {
    setExportingDoc({ id: run.id, format });
    setExportDocError(null);
    try {
      const response = await authFetch(`/api/reports/${run.id}/export?format=${format}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `report-${run.templateId}-${run.id}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportDocError({ id: run.id, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setExportingDoc((current) => (current?.id === run.id && current.format === format ? null : current));
    }
  };

  const copyMarkdown = async (run: ReportRun) => {
    const templateName = templateNames.get(run.templateId) ?? run.templateId;
    await navigator.clipboard.writeText(makeMarkdown(run, templateName));
    setCopiedId(run.id);
    window.setTimeout(() => setCopiedId((current) => current === run.id ? null : current), 1800);
  };

  const exportToVault = async (run: ReportRun) => {
    if (!isAuthenticated || exportingId) return;
    setExportingId(run.id);
    setMessage(null);
    try {
      const response = await authFetch(`/api/reports/${run.id}/export-vault`, { method: "POST" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
      setMessage(`Exported report to ${json.data?.path ?? "AI Vault"}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingId(null);
    }
  };

  return (
    <div className="dash-page reports-page">
      <section className="reports-hero">
        <div>
          <div className="dash-section-title">reports</div>
          <h1>Operational report archive</h1>
          <p>Generate, inspect, and export saved pipeline, content-health, gateway, and audit reports from Dashboard V4 evidence.</p>
        </div>
        <button type="button" className="btn" onClick={refresh}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </section>

      <section className="content-health-summary reports-summary">
        <div className="metric-tile">
          <span>Archived runs</span>
          <strong>{totals.total}</strong>
        </div>
        <div className="metric-tile">
          <span>Successful</span>
          <strong>{totals.success}</strong>
        </div>
        <div className="metric-tile">
          <span>Failed</span>
          <strong>{totals.failed}</strong>
        </div>
        <div className="metric-tile">
          <span>Rows stored</span>
          <strong>{totals.rows}</strong>
        </div>
      </section>

      <section className="reports-generate-panel">
        <div className="reports-generate-copy">
          <FileText size={20} />
          <div>
            <strong>Generate now</strong>
            <span>Run a template for the selected lookback window and store it in the archive.</span>
          </div>
        </div>
        <label>
          Template
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </select>
        </label>
        <label>
          Range
          <select value={range} onChange={(event) => setRange(event.target.value as RangePreset)}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </label>
        <button type="button" className="btn btn-primary" onClick={generateReport} disabled={!isAuthenticated || running || templates.length === 0}>
          <Play size={14} />
          {running ? "Running" : "Run report"}
        </button>
      </section>

      {!isAuthenticated && <div className="loading-panel error">Authentication is required to generate reports.</div>}
      {message && <div className="loading-panel">{message}</div>}
      {loading && !data && <div className="loading-panel">Loading report archive.</div>}
      {error && !data && <div className="loading-panel error">Reports did not load: {error} <button type="button" className="btn btn-sm btn-ghost" onClick={refresh}>Retry</button></div>}

      {summary.length > 0 && (
        <section className="dash-section">
          <div className="dash-section-title">template activity</div>
          <div className="reports-template-grid">
            {summary.slice(0, 6).map((row) => (
              <div className="content-health-kind-card" key={`${row.templateId}-${row.status}`}>
                <span>{templateNames.get(row.templateId) ?? row.templateId}</span>
                <strong>{row.count}</strong>
                <div className="w-row">
                  <span className={`pill ${statusClass(row.status)}`}>{row.status}</span>
                  <span className="dim">{formatDate(row.latestStartedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="dash-section">
        <div className="insight-group-title">
          <span>Archive</span>
          <span className="pill gray">{visibleRuns.filteredCount} / {runs.length}</span>
        </div>
        <TableControls
          {...visibleRuns.controlsProps}
          searchPlaceholder="Search run id, template, status, error..."
          className="reports-search"
        />

        {runs.length === 0 && !loading && (
          <div className="empty-state">
            <FileText size={24} />
            <strong>No report runs yet.</strong>
            <span>Generate a daily pipeline or content health report to seed the archive.</span>
          </div>
        )}

        <div className="reports-run-list">
          {visibleRuns.rows.map((run) => {
            const templateName = templateNames.get(run.templateId) ?? run.templateId;
            const canExport = run.status === "success";
            const period = formatPeriod(run);
            const exportingThis = exportingDoc?.id === run.id;
            return (
              <article className={`reports-run-card reports-run-card-${run.status}`} key={run.id}>
                <div className="reports-run-main">
                  <div className="reports-run-icon"><FileText size={16} /></div>
                  <div className="reports-run-copy">
                    <div className="reports-run-title">
                      <strong>{templateName}</strong>
                      <span className={`pill ${statusClass(run.status)}`}>{run.status}</span>
                    </div>
                    <span className="dim">{formatDate(run.startedAt)} · {run.rowCount} rows · <code>{run.id}</code></span>
                    {period && <span className="reports-run-period">Period: {period}</span>}
                    <ReportPreview run={run} />
                    {exportDocError?.id === run.id && (
                      <div className="reports-run-error"><AlertTriangle size={14} />{exportDocError.message}</div>
                    )}
                  </div>
                </div>
                <div className="reports-run-actions">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => copyMarkdown(run)} disabled={!canExport}>
                    {copiedId === run.id ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                    {copiedId === run.id ? "Copied" : "Copy md"}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => downloadCsv(run)} disabled={!canExport || downloadingId === run.id}>
                    <Download size={14} />
                    {downloadingId === run.id ? "Downloading" : "CSV"}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => exportToVault(run)} disabled={!canExport || !isAuthenticated || exportingId === run.id}>
                    <Upload size={14} />
                    {exportingId === run.id ? "Exporting" : "Vault"}
                  </button>
                  <label className="reports-export-control" title="Export a rich, natural-language document">
                    <FileDown size={14} />
                    <select
                      aria-label="Export report as document"
                      value=""
                      disabled={!canExport || !isAuthenticated || exportingThis}
                      onChange={(event) => {
                        const format = event.target.value as ExportFormat | "";
                        event.target.value = "";
                        if (format) downloadDocExport(run, format);
                      }}
                    >
                      <option value="" disabled>
                        {exportingThis ? `Exporting ${EXPORT_LABELS[exportingDoc!.format]}…` : "Export as…"}
                      </option>
                      <option value="pdf">PDF</option>
                      <option value="pptx">PowerPoint</option>
                      <option value="docx">Word</option>
                    </select>
                  </label>
                </div>
              </article>
            );
          })}
        </div>

        {runs.length > 0 && visibleRuns.filteredCount === 0 && (
          <div className="empty-state content-health-filter-empty">
            <FileText size={24} />
            <strong>No matching report runs.</strong>
            <span>Adjust the search text to widen the archive view.</span>
          </div>
        )}
      </section>
    </div>
  );
}
