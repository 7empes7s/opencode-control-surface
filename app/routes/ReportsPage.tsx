import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Download, FileDown, FileText, Play, RefreshCw, Upload } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { TableControls } from "../components/TableControls";
import { AnimatedNumber, Reveal, Stat } from "../components/v5/ui";
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
type ModuleRangePreset = "7d" | "30d" | "90d";
type ExportFormat = "pdf" | "pptx" | "docx";
type ActivityMetric = "rows" | "runs";
type ActivityStatusFilter = "all" | "success" | "failed" | "running";

type ModuleUsageRow = {
  path: string;
  pageviews: number;
  actions: number;
  findingsActedOn: number;
};

type ModuleUsageResponse = {
  from: string;
  to: string;
  modules: ModuleUsageRow[];
  totals: { pageviews: number; actions: number; findingsActedOn: number };
};

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

const MODULE_RANGE_DAYS: Record<ModuleRangePreset, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
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

function dayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function statusTone(status: string): "ok" | "warn" | "err" | "info" {
  if (status === "success") return "ok";
  if (status === "failed") return "err";
  if (status === "running") return "warn";
  return "info";
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
  const [moduleRange, setModuleRange] = useState<ModuleRangePreset>("30d");
  const [moduleUsage, setModuleUsage] = useState<ModuleUsageResponse | null>(null);
  const [moduleUsageLoading, setModuleUsageLoading] = useState(true);
  const [moduleUsageError, setModuleUsageError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [generatingDigest, setGeneratingDigest] = useState<"digest" | "executive" | "remediation" | "system-labor" | "sla-uptime" | "discovery-posture" | null>(null);
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
    return new Map([
      ...templates.map((template) => [template.id, template.name] as const),
      ["weekly-executive", "Weekly Executive Report"],
      ["monthly-remediation", "Monthly Remediation Report"],
      ["weekly-system-labor", "Weekly System Labor Report"],
      ["weekly-sla-uptime", "Weekly SLA / Uptime Report"],
      ["weekly-discovery-posture", "Weekly Discovery Posture Report"],
    ]);
  }, [templates]);

  const [activityTemplate, setActivityTemplate] = useState<string>("all");
  const [activityStatus, setActivityStatus] = useState<ActivityStatusFilter>("all");
  const [activityMetric, setActivityMetric] = useState<ActivityMetric>("rows");

  const activityTemplates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of summary) counts.set(row.templateId, (counts.get(row.templateId) ?? 0) + row.count);
    if (counts.size === 0) {
      for (const run of runs) counts.set(run.templateId, (counts.get(run.templateId) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([template]) => template);
    if (activityTemplate !== "all" && !top.includes(activityTemplate)) return [activityTemplate, ...top].slice(0, 6);
    return top;
  }, [summary, runs, activityTemplate]);

  const activityRuns = useMemo(() => {
    return runs.filter((run) => {
      if (activityTemplate !== "all" && run.templateId !== activityTemplate) return false;
      if (activityStatus !== "all" && run.status !== activityStatus) return false;
      return true;
    });
  }, [runs, activityTemplate, activityStatus]);

  const activitySeries = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (13 - index));
      return {
        key: dayKey(date.getTime()),
        label: date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" }),
        value: 0,
      };
    });
    const indexByKey = new Map(days.map((day, index) => [day.key, index]));
    for (const run of activityRuns) {
      if (!run.startedAt) continue;
      const index = indexByKey.get(dayKey(run.startedAt));
      if (index === undefined) continue;
      days[index].value += activityMetric === "rows" ? (run.rowCount ?? 0) : 1;
    }
    return days;
  }, [activityRuns, activityMetric]);

  const activityTotal = useMemo(() => activitySeries.reduce((sum, day) => sum + day.value, 0), [activitySeries]);

  const toggleActivityTemplate = (template: string) => {
    setActivityTemplate((current) => (current === template ? "all" : template));
  };

  const clearActivityFilters = () => {
    setActivityTemplate("all");
    setActivityStatus("all");
  };

  const visibleRuns = useTableControls<ReportRun, "startedAt">({
    rows: activityRuns,
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

  useEffect(() => {
    let cancelled = false;
    const tomorrow = new Date();
    tomorrow.setUTCHours(0, 0, 0, 0);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const from = new Date(tomorrow);
    from.setUTCDate(from.getUTCDate() - MODULE_RANGE_DAYS[moduleRange]);
    const query = new URLSearchParams({
      from: from.toISOString().slice(0, 10),
      to: tomorrow.toISOString().slice(0, 10),
    });

    setModuleUsageLoading(true);
    authFetch(`/api/usage/modules?${query}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        return body as ModuleUsageResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setModuleUsage(body);
        setModuleUsageError(null);
        setModuleUsageLoading(false);
      })
      .catch((fetchError: unknown) => {
        if (cancelled) return;
        setModuleUsageError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        setModuleUsageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [moduleRange]);

  const moduleTable = useTableControls<ModuleUsageRow, "path" | "pageviews" | "actions" | "findingsActedOn">({
    rows: moduleUsage?.modules ?? [],
    pageSize: 10,
    defaultSort: { key: "actions", dir: "desc" },
    filterText: (module) => module.path,
    sortValue: (module, key) => module[key],
    tieBreak: ["path"],
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

  const generateDigest = async (kind: "digest" | "executive" | "remediation" | "system-labor" | "sla-uptime" | "discovery-posture") => {
    if (!isAuthenticated || generatingDigest) return;
    setGeneratingDigest(kind);
    setMessage(null);
    try {
      const response = await authFetch(`/api/reports/${kind}`, { method: "POST" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
      setMessage(kind === "executive"
        ? "Generated weekly executive report."
        : kind === "remediation"
          ? "Generated monthly remediation report."
          : kind === "system-labor"
            ? "Generated weekly system labor report."
          : kind === "sla-uptime"
            ? "Generated weekly SLA / uptime report."
          : kind === "discovery-posture"
            ? "Generated weekly discovery posture report."
          : "Generated daily operator digest.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingDigest(null);
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
      <Reveal>
        <header className="v5-pagehead">
          <div className="v5-pagehead-row">
            <div>
              <div className="v5-pagehead-title">Reports</div>
              <p className="v5-pagehead-sub">Generate, inspect, and export saved pipeline, content-health, gateway, and audit reports from Dashboard V4 evidence.</p>
            </div>
            <button type="button" className="v5-btn" onClick={refresh}>
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </header>
      </Reveal>

      <Reveal delay={0.04}>
        <div className="v5-grid stats">
          <Stat label="Archived runs" value={<AnimatedNumber value={totals.total} />} />
          <Stat label="Successful" value={<AnimatedNumber value={totals.success} />} tone="ok" />
          <Stat label="Failed" value={<AnimatedNumber value={totals.failed} />} tone={totals.failed > 0 ? "err" : "idle"} />
          <Stat label="Rows stored" value={<AnimatedNumber value={totals.rows} />} gradient />
        </div>
      </Reveal>

      <Reveal delay={0.06}>
        <section className="v5-section">
          <div className="v5-card v5-activity-card">
            <div className="v5-activity-head">
              <div>
                <div className="v5-card-label">Interactive reporting</div>
                <div className="v5-activity-title">Report activity, live</div>
                <div className="v5-activity-sub">Filter the archive by template/status, switch metrics, and hover the series for exact daily values.</div>
              </div>
              <div className="v5-segmented" role="group" aria-label="Activity metric">
                <button type="button" aria-pressed={activityMetric === "rows"} className={activityMetric === "rows" ? "active" : ""} onClick={() => setActivityMetric("rows")}>Rows</button>
                <button type="button" aria-pressed={activityMetric === "runs"} className={activityMetric === "runs" ? "active" : ""} onClick={() => setActivityMetric("runs")}>Runs</button>
              </div>
            </div>

            <div className="v5-chip-row" role="group" aria-label="Template filters">
              <button type="button" aria-pressed={activityTemplate === "all"} className={`v5-chip${activityTemplate === "all" ? " active" : ""}`} onClick={() => setActivityTemplate("all")}>all templates</button>
              {activityTemplates.map((template) => (
                <button key={template} type="button" aria-pressed={activityTemplate === template} className={`v5-chip${activityTemplate === template ? " active" : ""}`} onClick={() => toggleActivityTemplate(template)}>
                  {templateNames.get(template) ?? template}
                </button>
              ))}
            </div>
            <div className="v5-chip-row" role="group" aria-label="Status filters">
              {(["all", "success", "failed", "running"] as const).map((status) => (
                <button key={status} type="button" aria-pressed={activityStatus === status} className={`v5-chip${activityStatus === status ? " active" : ""}`} onClick={() => setActivityStatus(status)}>
                  {status}
                </button>
              ))}
            </div>

            <div style={{ height: 220, position: "relative" }}>
              <ResponsiveContainer width="100%" height="100%" minHeight={180}>
                <AreaChart data={activitySeries} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="reportActivityFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.42} />
                      <stop offset="100%" stopColor="var(--accent-2)" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--text-muted)", fontSize: 11 }} />
                  <YAxis allowDecimals={false} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--text-muted)", fontSize: 11 }} />
                  <Tooltip
                    cursor={{ stroke: "var(--border-bright)" }}
                    contentStyle={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12 }}
                    formatter={(value) => [Number(value).toLocaleString(), activityMetric === "rows" ? "rows" : "runs"]}
                    labelFormatter={(label) => `Day ${label}`}
                  />
                  <Area type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={2.4} fill="url(#reportActivityFill)" animationDuration={900} dot={{ r: 2.4, fill: "var(--accent)" }} activeDot={{ r: 5, fill: "var(--accent-2)" }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="v5-activity-foot">
              <span>{activityTotal.toLocaleString()} {activityMetric === "rows" ? "rows" : "runs"} in the last 14 days · {activityRuns.length} total filtered runs</span>
              <button type="button" className="v5-btn ghost" onClick={clearActivityFilters} disabled={activityTemplate === "all" && activityStatus === "all"}>Clear activity filters</button>
            </div>
          </div>
        </section>
      </Reveal>

      <Reveal delay={0.08}>
        <div className="v5-card flat-hover" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flex: "1 1 280px", minWidth: 220 }}>
            <FileText size={20} style={{ color: "var(--accent)", flex: "none" }} />
            <div>
              <strong style={{ color: "var(--text-bright)" }}>Generate now</strong>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Run a template for the selected lookback window and store it in the archive.</div>
            </div>
          </div>
          <label style={{ display: "grid", gap: 4, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Template
            <select value={templateId} onChange={(event) => setTemplateId(event.target.value)} style={{ minHeight: 40 }}>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Range
            <select value={range} onChange={(event) => setRange(event.target.value as RangePreset)} style={{ minHeight: 40 }}>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
          <button type="button" className="v5-btn primary" onClick={generateReport} disabled={!isAuthenticated || running || templates.length === 0}>
            <Play size={14} />
            {running ? "Running" : "Run report"}
          </button>
        </div>
      </Reveal>

      <Reveal delay={0.12}>
        <div className="v5-card flat-hover" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flex: "1 1 100%", minWidth: 220 }}>
            <FileText size={20} style={{ color: "var(--accent-2)", flex: "none" }} />
            <div>
              <strong style={{ color: "var(--text-bright)" }}>Scheduled summaries</strong>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Generate the operator digest, executive, remediation-loop, system-labor, SLA / uptime, or discovery posture report immediately.</div>
            </div>
          </div>
          <button type="button" className="v5-btn" onClick={() => generateDigest("digest")} disabled={!isAuthenticated || generatingDigest !== null}>
            <Play size={14} />
            {generatingDigest === "digest" ? "Generating" : "Digest"}
          </button>
          <button type="button" className="v5-btn primary" onClick={() => generateDigest("executive")} disabled={!isAuthenticated || generatingDigest !== null}>
            <Play size={14} />
            {generatingDigest === "executive" ? "Generating" : "Executive"}
          </button>
          <button type="button" className="v5-btn" onClick={() => generateDigest("remediation")} disabled={!isAuthenticated || generatingDigest !== null}>
            <Play size={14} />
            {generatingDigest === "remediation" ? "Generating" : "Remediation"}
          </button>
          <button type="button" className="v5-btn" onClick={() => generateDigest("system-labor")} disabled={!isAuthenticated || generatingDigest !== null}>
            <Play size={14} />
            {generatingDigest === "system-labor" ? "Generating" : "System labor"}
          </button>
          <button type="button" className="v5-btn" onClick={() => generateDigest("sla-uptime")} disabled={!isAuthenticated || generatingDigest !== null}>
            <Play size={14} />
            {generatingDigest === "sla-uptime" ? "Generating" : "SLA / uptime"}
          </button>
          <button type="button" className="v5-btn" onClick={() => generateDigest("discovery-posture")} disabled={!isAuthenticated || generatingDigest !== null}>
            <Play size={14} />
            {generatingDigest === "discovery-posture" ? "Generating" : "Discovery posture"}
          </button>
        </div>
      </Reveal>

      {!isAuthenticated && (
        <div className="v5-card flat-hover" style={{ marginTop: 14, fontSize: 13, color: "var(--amber-warn)" }}>
          Authentication is required to generate reports.
        </div>
      )}
      {message && (
        <div className="v5-card flat-hover" style={{ marginTop: 14, fontSize: 13, color: "var(--text-dim)" }}>{message}</div>
      )}
      {loading && !data && (
        <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
          <div className="v5-skeleton" style={{ height: 18, width: "40%" }} />
          <div className="v5-skeleton" style={{ height: 120 }} />
        </div>
      )}
      {error && !data && (
        <div className="v5-card flat-hover" style={{ marginTop: 14, fontSize: 13, color: "var(--red)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          Reports did not load: {error}
          <button type="button" className="v5-btn ghost" onClick={refresh}>Retry</button>
        </div>
      )}

      {summary.length > 0 && (
        <Reveal delay={0.16}>
          <section className="v5-section">
            <div className="v5-section-head">
              <div className="v5-section-title">Template activity</div>
            </div>
            <div className="v5-grid cards">
              {summary.slice(0, 6).map((row) => (
                <button
                  className={`v5-card v5-click-card${activityTemplate === row.templateId ? " active" : ""}`}
                  key={`${row.templateId}-${row.status}`}
                  type="button"
                  aria-pressed={activityTemplate === row.templateId}
                  onClick={() => toggleActivityTemplate(row.templateId)}
                  title="Filter the interactive chart and archive to this template"
                >
                  <span className="v5-card-label">{templateNames.get(row.templateId) ?? row.templateId}</span>
                  <span className="v5-stat-value" style={{ display: "block" }}><AnimatedNumber value={row.count} /></span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                    <span className={`v5-pill ${statusTone(row.status)}`}>{row.status}</span>
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{formatDate(row.latestStartedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </Reveal>
      )}

      <Reveal delay={0.2}>
        <section className="v5-section">
          <div className="v5-section-head">
            <div className="v5-section-title">Module usage</div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
              Period
              <select value={moduleRange} onChange={(event) => setModuleRange(event.target.value as ModuleRangePreset)} style={{ minHeight: 40 }}>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
              </select>
            </label>
          </div>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)" }}>Which modules earn their keep — measured, not guessed.</p>

          <div className="v5-card flat-hover" style={{ padding: "8px 12px", marginBottom: 12 }}>
            <TableControls
              {...moduleTable.controlsProps}
              searchPlaceholder="Search module path..."
              className="reports-search"
            />
          </div>

          {moduleUsageLoading && !moduleUsage && (
            <div style={{ display: "grid", gap: 10 }}>
              <div className="v5-skeleton" style={{ height: 16, width: "35%" }} />
              <div className="v5-skeleton" style={{ height: 140 }} />
            </div>
          )}
          {moduleUsageError && !moduleUsage && (
            <div className="v5-card flat-hover" style={{ fontSize: 13, color: "var(--red)" }}>Module usage did not load: {moduleUsageError}</div>
          )}
          {!moduleUsageLoading && moduleUsage?.modules.length === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
              No usage recorded yet — usage accrues as the dashboard is used.
            </p>
          )}

          {moduleUsage && moduleUsage.modules.length > 0 && (
            <div className="v5-table-wrap">
              <table className="v5-table responsive">
                <thead>
                  <tr>
                    <th {...moduleTable.sortHeaderProps("path")}>Module <span className="sortable-th-arrow">{moduleTable.sort.key === "path" ? (moduleTable.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th {...moduleTable.sortHeaderProps("pageviews")}>Visits <span className="sortable-th-arrow">{moduleTable.sort.key === "pageviews" ? (moduleTable.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th {...moduleTable.sortHeaderProps("actions")}>Actions <span className="sortable-th-arrow">{moduleTable.sort.key === "actions" ? (moduleTable.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th {...moduleTable.sortHeaderProps("findingsActedOn")}>Findings acted on <span className="sortable-th-arrow">{moduleTable.sort.key === "findingsActedOn" ? (moduleTable.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {moduleTable.rows.map((module) => (
                    <tr key={module.path}>
                      <td data-label="Module" className="mono">{module.path}</td>
                      <td data-label="Visits" className="mono">{module.pageviews.toLocaleString()}</td>
                      <td data-label="Actions" className="mono">{module.actions.toLocaleString()}</td>
                      <td data-label="Findings acted on" className="mono">{module.findingsActedOn.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td><strong>Total</strong></td>
                    <td className="mono"><strong>{moduleUsage.totals.pageviews.toLocaleString()}</strong></td>
                    <td className="mono"><strong>{moduleUsage.totals.actions.toLocaleString()}</strong></td>
                    <td className="mono"><strong>{moduleUsage.totals.findingsActedOn.toLocaleString()}</strong></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {moduleUsage && moduleUsage.modules.length > 0 && moduleTable.filteredCount === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 12 }}>
              No modules match the current search — adjust the filter to widen the usage view.
            </p>
          )}
        </section>
      </Reveal>

      <Reveal delay={0.24}>
        <section className="v5-section">
          <div className="v5-section-head">
            <div className="v5-section-title">Archive</div>
            <span className="v5-pill info">{visibleRuns.filteredCount} / {activityRuns.length} in scope · {runs.length} total</span>
          </div>

          <div className="v5-card flat-hover" style={{ padding: "8px 12px", marginBottom: 12 }}>
            <TableControls
              {...visibleRuns.controlsProps}
              searchPlaceholder="Search run id, template, status, error..."
              className="reports-search"
            />
          </div>

          {runs.length === 0 && !loading && (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
              No report runs yet — generate a daily pipeline or content health report to seed the archive.
            </p>
          )}

          <div style={{ display: "grid", gap: 12 }}>
            {visibleRuns.rows.map((run, index) => {
              const templateName = templateNames.get(run.templateId) ?? run.templateId;
              const canExport = run.status === "success";
              const period = formatPeriod(run);
              const exportingThis = exportingDoc?.id === run.id;
              return (
                <article
                  className="v5-card v5-archive-card"
                  key={run.id}
                  style={{ display: "flex", flexWrap: "wrap", gap: 14, justifyContent: "space-between", animationDelay: `${Math.min(index * 0.035, 0.35)}s` }}
                >
                  <div style={{ display: "flex", gap: 12, flex: "1 1 320px", minWidth: 0 }}>
                    <div style={{ flex: "none", width: 34, height: 34, borderRadius: "var(--r-md)", display: "grid", placeItems: "center", background: "var(--grad-accent-soft)", color: "var(--accent)" }}>
                      <FileText size={16} />
                    </div>
                    <div style={{ minWidth: 0, display: "grid", gap: 4, alignContent: "start" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <strong style={{ color: "var(--text-bright)" }}>{templateName}</strong>
                        <span className={`v5-pill ${statusTone(run.status)}`}>{run.status}</span>
                      </div>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{formatDate(run.startedAt)} · {run.rowCount} rows · <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{run.id}</code></span>
                      {period && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Period: {period}</span>}
                      <ReportPreview run={run} />
                      {exportDocError?.id === run.id && (
                        <div className="reports-run-error"><AlertTriangle size={14} />{exportDocError.message}</div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", alignContent: "flex-start" }}>
                    <button type="button" className="v5-btn ghost" onClick={() => copyMarkdown(run)} disabled={!canExport}>
                      {copiedId === run.id ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                      {copiedId === run.id ? "Copied" : "Copy md"}
                    </button>
                    <button type="button" className="v5-btn ghost" onClick={() => downloadCsv(run)} disabled={!canExport || downloadingId === run.id}>
                      <Download size={14} />
                      {downloadingId === run.id ? "Downloading" : "CSV"}
                    </button>
                    <button type="button" className="v5-btn ghost" onClick={() => exportToVault(run)} disabled={!canExport || !isAuthenticated || exportingId === run.id}>
                      <Upload size={14} />
                      {exportingId === run.id ? "Exporting" : "Vault"}
                    </button>
                    <label className="v5-btn ghost" style={{ cursor: "pointer" }} title="Export a rich, natural-language document">
                      <FileDown size={14} />
                      <select
                        aria-label="Export report as document"
                        value=""
                        disabled={!canExport || !isAuthenticated || exportingThis}
                        style={{ background: "transparent", border: "none", color: "inherit", font: "inherit", minHeight: 0, cursor: "pointer" }}
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
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 12 }}>
              No report runs match the current search — adjust the filter to widen the archive view.
            </p>
          )}
        </section>
      </Reveal>
    </div>
  );
}
