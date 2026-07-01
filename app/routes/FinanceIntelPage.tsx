import { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  ExternalLink,
  FileSearch,
  Gauge,
  PieChart,
  Settings2,
  TrendingUp,
} from "lucide-react";
import { SectionCard } from "../components/SectionCard.tsx";
import { TableControls } from "../components/TableControls.tsx";
import { useTableControls } from "../hooks/useTableControls.ts";
import { AnimatedNumber } from "../components/AnimatedCharts.tsx";
import { authFetch } from "../lib/authFetch.ts";

interface FinanceRun {
  id: string;
  run_at: string;
  duration_ms: number;
  model_used: string;
  article_window_days: number;
  articles_corpus: string;
  market_data: string;
  fred_data: string;
  llm_prompt: string;
  llm_response: string;
  prompt_tokens: number;
  completion_tokens: number;
  insights_count: number;
  insights_ticker: number;
  insights_macro: number;
  insights_anomaly: number;
  portfolio_config_id: string;
  status: string;
  error: string;
}

interface FinanceEnrichment {
  id: number;
  run_at: string;
  article_slug: string;
  articleSlug?: string;
  model_used: string;
  tickers_extracted: string;
  ticker?: string;
  confidence: number | string;
  duration_ms: number;
  status: string;
}

interface PortfolioConfig {
  id: string;
  name: string;
  risk_tolerance: number;
  confidence_threshold: number;
  timeframe_pref: string;
  watchlist: string;
  excluded_verticals: string;
  article_window_days: number;
  analyst_persona: string;
  created_at: string;
}

interface Stats {
  totalRuns?: number;
  totalEnrichments?: number;
  avgDurationMs?: number;
  activePortfolios?: number;
  runCount?: number;
  enrichmentCount?: number;
  configCount?: number;
  runStatusDistribution?: Array<{ status: string; count: number }>;
}

export type RunsSortKey = "run_at" | "duration_ms" | "model_used" | "article_window_days" | "articles_corpus" | "market_data" | "status";
export type EnrichmentsSortKey = "run_at" | "article_slug" | "model_used" | "tickers_extracted" | "confidence" | "duration_ms" | "status";
export type ConfigsSortKey = "name" | "risk_tolerance" | "confidence_threshold" | "watchlist" | "created_at";

const ARTICLE_BASE_URL = "https://news.techinsiderbytes.com/articles/";

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    if (typeof parsed === "string" && parsed.trim()) return [parsed];
    return [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function prettyJson(value: unknown): string {
  if (value === null || value === undefined || value === "") return "No data recorded.";
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function arrayCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "string" || !value.trim()) return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function corpusLabel(value: unknown) {
  const count = arrayCount(value);
  if (count > 0) return `${count} article${count === 1 ? "" : "s"}`;
  if (typeof value === "string" && value.trim()) return value;
  return "-";
}

function marketDataLabel(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "-";
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      return keys.length ? keys.slice(0, 3).join(", ") : "snapshot";
    }
    if (Array.isArray(parsed)) return `${parsed.length} series`;
    return String(parsed);
  } catch {
    return value.length > 42 ? `${value.slice(0, 42)}...` : value;
  }
}

function fmtDate(value: string | number | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function fmtDateShort(value: string | number | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
}

function fmtDuration(ms: number | null | undefined) {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function confidenceValue(value: number | string | null | undefined) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function confidenceLabel(value: number | string | null | undefined) {
  const n = confidenceValue(value);
  if (!n) return "-";
  return n <= 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
}

function statusPillClass(status: string | null | undefined) {
  const normalized = (status ?? "").toLowerCase();
  if (["success", "ok", "done", "complete", "completed"].includes(normalized)) return "green";
  if (["failed", "error", "rejected"].includes(normalized)) return "red";
  if (["running", "pending", "queued", "queue"].includes(normalized)) return "amber";
  return "gray";
}

function sortableArrow<K extends string>(ctrl: ReturnType<typeof useTableControls<any, K>>, key: K) {
  return <span className="sortable-th-arrow">{ctrl.sort.key === key ? (ctrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>;
}

function sourceUrl(slug: string) {
  return `${ARTICLE_BASE_URL}${encodeURIComponent(slug)}`;
}

function StatCard({
  icon,
  label,
  value,
  suffix,
  sub,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  suffix?: string;
  sub?: string;
}) {
  return (
    <div className="finance-stat-card">
      <div className="finance-stat-icon">{icon}</div>
      <div>
        <span className="finance-stat-label">{label}</span>
        <strong><AnimatedNumber value={value} />{suffix}</strong>
        {sub && <em>{sub}</em>}
      </div>
    </div>
  );
}

function RunDetail({ run }: { run: FinanceRun }) {
  return (
    <div className="data-row-detail-inner finance-detail">
      <p className="finance-detail-lede">
        The finance agent analyzed a {run.article_window_days || "-"} day article window covering <strong>{corpusLabel(run.articles_corpus)}</strong>, using <strong className="mono">{run.model_used || "unknown model"}</strong>. It recorded {run.insights_count ?? 0} insight{run.insights_count === 1 ? "" : "s"} in {fmtDuration(run.duration_ms)}.
      </p>
      <div className="data-row-detail-grid">
        <div><span>model</span><strong>{run.model_used || "-"}</strong></div>
        <div><span>window</span><strong>{run.article_window_days ? `${run.article_window_days} days` : "-"}</strong></div>
        <div><span>corpus size</span><strong>{corpusLabel(run.articles_corpus)}</strong></div>
        <div><span>market data</span><strong>{marketDataLabel(run.market_data)}</strong></div>
        <div><span>ticker insights</span><strong>{run.insights_ticker ?? 0}</strong></div>
        <div><span>macro insights</span><strong>{run.insights_macro ?? 0}</strong></div>
        <div><span>anomalies</span><strong>{run.insights_anomaly ?? 0}</strong></div>
        <div><span>tokens</span><strong>{(run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0)}</strong></div>
      </div>
      <div className="finance-detail-code-grid">
        <div>
          <span>market_data detail</span>
          <pre className="detail-json">{prettyJson(run.market_data)}</pre>
        </div>
        <div>
          <span>FRED detail</span>
          <pre className="detail-json">{prettyJson(run.fred_data)}</pre>
        </div>
      </div>
      {run.error && <div className="finance-error-copy">Run error: {run.error}</div>}
    </div>
  );
}

function EnrichmentDetail({ enrichment }: { enrichment: FinanceEnrichment }) {
  const slug = enrichment.article_slug || enrichment.articleSlug || "";
  const tickers = parseJsonArray(enrichment.tickers_extracted || enrichment.ticker);
  const conf = confidenceLabel(enrichment.confidence);
  return (
    <div className="data-row-detail-inner finance-detail">
      <p className="finance-detail-lede">
        The finance agent analyzed article <strong>{slug || "unknown article"}</strong>, extracted <strong>{tickers.length ? tickers.join(", ") : "no ticker symbols recorded"}</strong> at confidence <strong>{conf}</strong> using <strong className="mono">{enrichment.model_used || "unknown model"}</strong>.
      </p>
      <div className="finance-finding-source-row">
        {slug ? (
          <a className="finance-source-link" href={sourceUrl(slug)} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            Open source article
          </a>
        ) : (
          <span className="text-muted">No article slug recorded for this enrichment.</span>
        )}
      </div>
      <div className="data-row-detail-grid">
        <div><span>article</span><strong>{slug || "-"}</strong></div>
        <div><span>tickers extracted</span><strong>{tickers.length ? tickers.join(", ") : "none"}</strong></div>
        <div><span>confidence</span><strong>{conf}</strong></div>
        <div><span>model</span><strong>{enrichment.model_used || "-"}</strong></div>
        <div><span>duration</span><strong>{fmtDuration(enrichment.duration_ms)}</strong></div>
        <div><span>status</span><strong>{enrichment.status || "-"}</strong></div>
      </div>
      <div className="finance-ticker-strip" aria-label="Extracted tickers">
        {tickers.length ? tickers.map((ticker) => <span className="finance-ticker" key={ticker}>{ticker}</span>) : <span className="text-muted">No ticker evidence in row.</span>}
      </div>
    </div>
  );
}

export function FinanceIntelPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [runs, setRuns] = useState<FinanceRun[]>([]);
  const [enrichments, setEnrichments] = useState<FinanceEnrichment[]>([]);
  const [configs, setConfigs] = useState<PortfolioConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const computedAvgDuration = useMemo(() => {
    const durations = runs.map((run) => Number(run.duration_ms)).filter((value) => Number.isFinite(value) && value > 0);
    if (durations.length === 0) return 0;
    return Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
  }, [runs]);

  const statusDistribution = stats?.runStatusDistribution ?? [];
  const successfulRuns = statusDistribution.find((row) => ["success", "ok", "done"].includes(row.status.toLowerCase()))?.count ?? 0;

  const runsCtrl = useTableControls<FinanceRun, RunsSortKey>({
    rows: runs,
    pageSize: 10,
    rowKey: (row) => row.id,
    filterText: (row) => [row.id, row.model_used, row.status, row.articles_corpus, row.market_data].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "run_at": return row.run_at;
        case "duration_ms": return row.duration_ms ?? 0;
        case "model_used": return row.model_used ?? "";
        case "article_window_days": return row.article_window_days ?? 0;
        case "articles_corpus": return row.articles_corpus ?? "";
        case "market_data": return row.market_data ?? "";
        case "status": return row.status ?? "";
        default: return "";
      }
    },
    defaultSort: { key: "run_at", dir: "desc" },
  });

  const enrichmentsCtrl = useTableControls<FinanceEnrichment, EnrichmentsSortKey>({
    rows: enrichments,
    pageSize: 10,
    rowKey: (row) => String(row.id),
    filterText: (row) => [
      row.id,
      row.article_slug || row.articleSlug,
      row.model_used,
      row.status,
      ...parseJsonArray(row.tickers_extracted || row.ticker),
    ].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "run_at": return row.run_at;
        case "article_slug": return row.article_slug || row.articleSlug || "";
        case "model_used": return row.model_used ?? "";
        case "tickers_extracted": return parseJsonArray(row.tickers_extracted || row.ticker).length;
        case "confidence": return confidenceValue(row.confidence);
        case "duration_ms": return row.duration_ms ?? 0;
        case "status": return row.status ?? "";
        default: return "";
      }
    },
    defaultSort: { key: "run_at", dir: "desc" },
  });

  const configsCtrl = useTableControls<PortfolioConfig, ConfigsSortKey>({
    rows: configs,
    pageSize: 10,
    rowKey: (row) => row.id || row.name,
    filterText: (row) => [row.name, row.timeframe_pref, row.analyst_persona, row.watchlist].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "name": return row.name ?? "";
        case "risk_tolerance": return row.risk_tolerance ?? 0;
        case "confidence_threshold": return row.confidence_threshold ?? 0;
        case "watchlist": return parseJsonArray(row.watchlist).length;
        case "created_at": return row.created_at;
        default: return "";
      }
    },
    defaultSort: { key: "created_at", dir: "desc" },
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    Promise.all([
      authFetch("/api/finance-intel/stats").then((res) => res.json()),
      authFetch("/api/finance-intel/runs").then((res) => res.json()),
      authFetch("/api/finance-intel/enrichments").then((res) => res.json()),
      authFetch("/api/finance-intel/portfolio-configs").then((res) => res.json()),
    ])
      .then(([statsPayload, runsPayload, enrichmentsPayload, configsPayload]) => {
        if (!active) return;
        setStats(statsPayload.data ?? statsPayload);
        setRuns(Array.isArray(runsPayload.data) ? runsPayload.data : Array.isArray(runsPayload) ? runsPayload : []);
        setEnrichments(Array.isArray(enrichmentsPayload.data) ? enrichmentsPayload.data : Array.isArray(enrichmentsPayload) ? enrichmentsPayload : []);
        setConfigs(configsPayload.data?.portfolio ?? (Array.isArray(configsPayload.data) ? configsPayload.data : Array.isArray(configsPayload) ? configsPayload : []));
      })
      .catch((err) => {
        if (active) setError(`Failed to load finance intelligence: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, []);

  if (loading) {
    return (
      <div className="dash-page page finance-intel-page">
        <div className="page-header">
          <div className="page-title">Finance Intel</div>
        </div>
        <div className="loading-dim">loading finance agent evidence…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dash-page page finance-intel-page">
        <div className="page-header">
          <div className="page-title">Finance Intel</div>
        </div>
        <div className="loading-dim error">{error}</div>
      </div>
    );
  }

  const totalRuns = stats?.totalRuns ?? stats?.runCount ?? runs.length;
  const totalEnrichments = stats?.totalEnrichments ?? stats?.enrichmentCount ?? enrichments.length;
  const activePortfolios = stats?.activePortfolios ?? stats?.configCount ?? configs.length;
  const avgDuration = stats?.avgDurationMs || computedAvgDuration;

  return (
    <div className="dash-page page finance-intel-page">
      <div className="page-header finance-page-header">
        <div>
          <div className="page-title">Finance Intel</div>
          <p className="finance-page-subtitle">
            Run provenance, article findings, extracted tickers, confidence, and source evidence from the finance agent.
          </p>
        </div>
        <div className="finance-status-stack">
          {statusDistribution.length > 0 ? statusDistribution.map((row) => (
            <span key={row.status} className={`pill ${statusPillClass(row.status)}`}>{row.status}: {row.count}</span>
          )) : <span className="pill gray">no run statuses</span>}
        </div>
      </div>

      <section className="finance-stats-grid" aria-label="Finance intelligence summary">
        <StatCard icon={<Activity size={18} />} label="total runs" value={totalRuns} sub={`${successfulRuns} successful in status history`} />
        <StatCard icon={<FileSearch size={18} />} label="findings" value={totalEnrichments} sub="article enrichments recorded" />
        <StatCard icon={<Clock size={18} />} label="avg duration" value={avgDuration} suffix={avgDuration ? "ms" : ""} sub={avgDuration ? "from stats or recent rows" : "not recorded"} />
        <StatCard icon={<PieChart size={18} />} label="portfolios" value={activePortfolios} sub="active configs" />
      </section>

      {runs.length === 0 && enrichments.length === 0 && (
        <div className="empty-state">
          <Database size={24} />
          <strong>No finance agent activity recorded.</strong>
          <span>The API returned no runs or enrichments, so this page is showing an honest empty state.</span>
        </div>
      )}

      <div className="finance-layout-grid">
        <main className="finance-main-stack">
          <SectionCard title={<><BarChart3 size={16} /> Recent runs — what the agent did</>} defaultOpen={true}>
            <div className="section-card-body table-wrap finance-table-panel">
              <TableControls {...runsCtrl.controlsProps} searchPlaceholder="Search id, model, corpus, market data, status..." />
              <div className="table-container">
                <table className="data-table finance-runs-table">
                  <thead>
                    <tr>
                      <th className="expander-col" aria-label="Details"></th>
                      <th {...runsCtrl.sortHeaderProps("run_at")}>Run at {sortableArrow(runsCtrl, "run_at")}</th>
                      <th>ID</th>
                      <th {...runsCtrl.sortHeaderProps("duration_ms")}>Duration {sortableArrow(runsCtrl, "duration_ms")}</th>
                      <th {...runsCtrl.sortHeaderProps("model_used")}>Model {sortableArrow(runsCtrl, "model_used")}</th>
                      <th {...runsCtrl.sortHeaderProps("article_window_days")}>Window {sortableArrow(runsCtrl, "article_window_days")}</th>
                      <th {...runsCtrl.sortHeaderProps("articles_corpus")}>Corpus {sortableArrow(runsCtrl, "articles_corpus")}</th>
                      <th {...runsCtrl.sortHeaderProps("market_data")}>Market data {sortableArrow(runsCtrl, "market_data")}</th>
                      <th {...runsCtrl.sortHeaderProps("status")}>Status {sortableArrow(runsCtrl, "status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runsCtrl.rows.map((run) => {
                      const rowKey = runsCtrl.getRowKey(run);
                      const expanded = runsCtrl.isExpanded(rowKey);
                      return (
                        <Fragment key={rowKey}>
                          <tr>
                            <td className="expander-col">
                              <button className="table-expander" type="button" onClick={() => runsCtrl.toggleExpanded(rowKey)} aria-expanded={expanded} aria-label={`Toggle details for run ${run.id}`}>
                                {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                              </button>
                            </td>
                            <td className="mono dim">{fmtDate(run.run_at)}</td>
                            <td className="mono cell-ellipsis" title={run.id}>{run.id}</td>
                            <td>{fmtDuration(run.duration_ms)}</td>
                            <td className="mono cell-ellipsis" title={run.model_used}>{run.model_used || "-"}</td>
                            <td>{run.article_window_days ? `${run.article_window_days}d` : "-"}</td>
                            <td className="cell-ellipsis" title={run.articles_corpus}>{corpusLabel(run.articles_corpus)}</td>
                            <td className="cell-ellipsis" title={run.market_data}>{marketDataLabel(run.market_data)}</td>
                            <td><span className={`pill ${statusPillClass(run.status)}`}>{run.status || "unknown"}</span></td>
                          </tr>
                          {expanded && (
                            <tr className="data-row-detail">
                              <td colSpan={9}>
                                <RunDetail run={run} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {runsCtrl.rows.length === 0 && (
                      <tr><td colSpan={9} className="text-muted">No matching runs.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </SectionCard>

          <SectionCard title={<><FileSearch size={16} /> Findings — what it found and why</>} defaultOpen={true}>
            <div className="section-card-body table-wrap finance-table-panel">
              <TableControls {...enrichmentsCtrl.controlsProps} searchPlaceholder="Search article, ticker, model, status..." />
              <div className="table-container">
                <table className="data-table finance-findings-table">
                  <thead>
                    <tr>
                      <th className="expander-col" aria-label="Details"></th>
                      <th {...enrichmentsCtrl.sortHeaderProps("run_at")}>Run at {sortableArrow(enrichmentsCtrl, "run_at")}</th>
                      <th {...enrichmentsCtrl.sortHeaderProps("article_slug")}>Article {sortableArrow(enrichmentsCtrl, "article_slug")}</th>
                      <th {...enrichmentsCtrl.sortHeaderProps("model_used")}>Model {sortableArrow(enrichmentsCtrl, "model_used")}</th>
                      <th {...enrichmentsCtrl.sortHeaderProps("tickers_extracted")}>Tickers {sortableArrow(enrichmentsCtrl, "tickers_extracted")}</th>
                      <th {...enrichmentsCtrl.sortHeaderProps("confidence")}>Confidence {sortableArrow(enrichmentsCtrl, "confidence")}</th>
                      <th {...enrichmentsCtrl.sortHeaderProps("duration_ms")}>Duration {sortableArrow(enrichmentsCtrl, "duration_ms")}</th>
                      <th {...enrichmentsCtrl.sortHeaderProps("status")}>Status {sortableArrow(enrichmentsCtrl, "status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {enrichmentsCtrl.rows.map((enrichment) => {
                      const rowKey = enrichmentsCtrl.getRowKey(enrichment);
                      const expanded = enrichmentsCtrl.isExpanded(rowKey);
                      const slug = enrichment.article_slug || enrichment.articleSlug || "";
                      const tickers = parseJsonArray(enrichment.tickers_extracted || enrichment.ticker);
                      return (
                        <Fragment key={rowKey}>
                          <tr>
                            <td className="expander-col">
                              <button className="table-expander" type="button" onClick={() => enrichmentsCtrl.toggleExpanded(rowKey)} aria-expanded={expanded} aria-label={`Toggle details for finding ${enrichment.id}`}>
                                {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                              </button>
                            </td>
                            <td className="mono dim">{fmtDate(enrichment.run_at)}</td>
                            <td className="cell-ellipsis" title={slug}>
                              {slug ? <a href={sourceUrl(slug)} target="_blank" rel="noreferrer">{slug}</a> : "-"}
                            </td>
                            <td className="mono cell-ellipsis" title={enrichment.model_used}>{enrichment.model_used || "-"}</td>
                            <td>{tickers.length ? tickers.slice(0, 4).join(", ") : "none"}</td>
                            <td>{confidenceLabel(enrichment.confidence)}</td>
                            <td>{fmtDuration(enrichment.duration_ms)}</td>
                            <td><span className={`pill ${statusPillClass(enrichment.status)}`}>{enrichment.status || "unknown"}</span></td>
                          </tr>
                          {expanded && (
                            <tr className="data-row-detail">
                              <td colSpan={8}>
                                <EnrichmentDetail enrichment={enrichment} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {enrichmentsCtrl.rows.length === 0 && (
                      <tr><td colSpan={8} className="text-muted">No matching findings.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </SectionCard>
        </main>

        <aside className="finance-side-stack">
          <SectionCard title={<><Settings2 size={16} /> Portfolio configuration</>} defaultOpen={true}>
            <div className="section-card-body finance-form-stack">
              <label className="finance-field">
                Active portfolio
                <select className="form-select">
                  {configs.map((config) => (
                    <option key={config.id} value={config.id}>{config.name}</option>
                  ))}
                  <option value="">Create New...</option>
                </select>
              </label>
              <label className="finance-field">
                Risk tolerance
                <input type="range" min="1" max="10" defaultValue="5" className="form-range" />
                <div className="range-labels">
                  <span>Conservative</span>
                  <span>Moderate</span>
                  <span>Aggressive</span>
                </div>
              </label>
              <label className="finance-field">
                Confidence threshold
                <input type="number" step="0.01" min="0" max="1" defaultValue="0.6" className="form-input" />
              </label>
              <label className="finance-field">
                Timeframe preference
                <select className="form-select" defaultValue="medium">
                  <option value="short">Short-term (1-7 days)</option>
                  <option value="medium">Medium-term (1-30 days)</option>
                  <option value="long">Long-term (30+ days)</option>
                  <option value="all">All timeframes</option>
                </select>
              </label>
              <button className="btn btn-primary w-full" type="button">Save Configuration</button>
            </div>
          </SectionCard>

          <SectionCard title={<><TrendingUp size={16} /> Manual trigger</>} defaultOpen={true}>
            <div className="section-card-body finance-form-stack">
              <label className="finance-field">
                Analysis window
                <select className="form-select" defaultValue="14">
                  <option value="7">Last 7 days</option>
                  <option value="14">Last 14 days</option>
                  <option value="30">Last 30 days</option>
                </select>
              </label>
              <label className="finance-field">
                Model selection
                <select className="form-select" defaultValue="editorial-fast">
                  <option value="editorial-heavy">editorial-heavy</option>
                  <option value="editorial-fast">editorial-fast</option>
                  <option value="cloud-heavy">cloud-heavy</option>
                </select>
              </label>
              <button className="btn btn-success w-full" type="button">
                <TrendingUp size={16} />
                Run Analysis
              </button>
            </div>
          </SectionCard>

          <SectionCard title={<><Gauge size={16} /> Portfolio records</>} defaultOpen={true}>
            <div className="section-card-body table-wrap finance-config-table-wrap">
              <TableControls {...configsCtrl.controlsProps} searchPlaceholder="Search portfolios..." />
              <div className="table-container">
                <table className="data-table finance-config-table">
                  <thead>
                    <tr>
                      <th {...configsCtrl.sortHeaderProps("name")}>Name {sortableArrow(configsCtrl, "name")}</th>
                      <th {...configsCtrl.sortHeaderProps("risk_tolerance")}>Risk {sortableArrow(configsCtrl, "risk_tolerance")}</th>
                      <th {...configsCtrl.sortHeaderProps("confidence_threshold")}>Conf {sortableArrow(configsCtrl, "confidence_threshold")}</th>
                      <th {...configsCtrl.sortHeaderProps("watchlist")}>Watch {sortableArrow(configsCtrl, "watchlist")}</th>
                      <th {...configsCtrl.sortHeaderProps("created_at")}>Created {sortableArrow(configsCtrl, "created_at")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configsCtrl.rows.map((config) => (
                      <tr key={configsCtrl.getRowKey(config)}>
                        <td className="cell-ellipsis" title={config.name}>{config.name || "-"}</td>
                        <td>{config.risk_tolerance ?? "-"}/10</td>
                        <td>{config.confidence_threshold ?? "-"}</td>
                        <td>{parseJsonArray(config.watchlist).length}</td>
                        <td className="mono dim">{fmtDateShort(config.created_at)}</td>
                      </tr>
                    ))}
                    {configsCtrl.rows.length === 0 && (
                      <tr><td colSpan={5} className="text-muted">No portfolio configs.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </SectionCard>
        </aside>
      </div>
    </div>
  );
}
