import { useState, useEffect } from "react";
import { SectionCard } from "../components/SectionCard.tsx";
import { TableControls } from "../components/TableControls.tsx";
import { useTableControls } from "../hooks/useTableControls.ts";
import { AnimatedNumber } from "../components/AnimatedCharts.tsx";
import { TrendingUp, BarChart, PieChart, Activity, Clock, Database, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
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
  model_used: string;
  tickers_extracted: string;
  confidence: number;
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
  runCount: number;
  enrichmentCount: number;
  configCount: number;
  runStatusDistribution: Array<{ status: string; count: number }>;
}

export type RunsSortKey = "run_at" | "duration_ms" | "model_used" | "status" | "insights_count";
export type EnrichmentsSortKey = "run_at" | "model_used" | "tickers_extracted" | "confidence" | "status";
export type ConfigsSortKey = "name" | "risk_tolerance" | "confidence_threshold" | "watchlist" | "created_at";

export function FinanceIntelPage() {
  const [activeTab, setActiveTab] = useState<"runs" | "enrichments" | "configs">("runs");
  const [stats, setStats] = useState<Stats | null>(null);
  const [runs, setRuns] = useState<FinanceRun[]>([]);
  const [enrichments, setEnrichments] = useState<FinanceEnrichment[]>([]);
  const [configs, setConfigs] = useState<PortfolioConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runsCtrl = useTableControls<FinanceRun, RunsSortKey>({
    rows: runs,
    pageSize: 25,
    filterText: (row) => [row.id, row.model_used, row.status].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "run_at": return row.run_at;
        case "duration_ms": return row.duration_ms ?? 0;
        case "model_used": return row.model_used ?? "";
        case "status": return row.status ?? "";
        case "insights_count": return row.insights_count ?? 0;
        default: return "";
      }
    },
    defaultSort: { key: "run_at", dir: "desc" },
  });

  const enrichmentsCtrl = useTableControls<FinanceEnrichment, EnrichmentsSortKey>({
    rows: enrichments,
    pageSize: 25,
    filterText: (row) => [row.article_slug, row.model_used, row.status].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "run_at": return row.run_at;
        case "model_used": return row.model_used ?? "";
        case "tickers_extracted": return row.tickers_extracted ? JSON.parse(row.tickers_extracted).length : 0;
        case "confidence": return row.confidence ?? 0;
        case "status": return row.status ?? "";
        default: return "";
      }
    },
    defaultSort: { key: "run_at", dir: "desc" },
  });

  const configsCtrl = useTableControls<PortfolioConfig, ConfigsSortKey>({
    rows: configs,
    pageSize: 25,
    filterText: (row) => [row.name, row.timeframe_pref, row.analyst_persona].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "name": return row.name ?? "";
        case "risk_tolerance": return row.risk_tolerance ?? 0;
        case "confidence_threshold": return row.confidence_threshold ?? 0;
        case "watchlist": return row.watchlist ?? "";
        case "created_at": return row.created_at;
        default: return "";
      }
    },
    defaultSort: { key: "created_at", dir: "desc" },
  });

  useEffect(() => {
    // Load stats
    authFetch("/api/finance-intel/stats")
      .then(res => res.json())
      .then(d => setStats(d.data ?? d))
      .catch(err => setError(`Failed to load stats: ${err.message}`));

    // Load runs
    authFetch("/api/finance-intel/runs")
      .then(res => res.json())
      .then(d => {
        setRuns(Array.isArray(d.data) ? d.data : Array.isArray(d) ? d : []);
        setLoading(false);
      })
      .catch(err => {
        setError(`Failed to load runs: ${err.message}`);
        setLoading(false);
      });

    // Load enrichments
    authFetch("/api/finance-intel/enrichments")
      .then(res => res.json())
      .then(d => setEnrichments(Array.isArray(d.data) ? d.data : Array.isArray(d) ? d : []))
      .catch(err => setError(`Failed to load enrichments: ${err.message}`));

    // Load configs
    authFetch("/api/finance-intel/portfolio-configs")
      .then(res => res.json())
      .then(d => setConfigs(d.data?.portfolio ?? (Array.isArray(d.data) ? d.data : Array.isArray(d) ? d : [])))
      .catch(err => setError(`Failed to load configs: ${err.message}`));
  }, []);

  if (loading) {
    return (
      <div className="page">
        <div className="page-header">
          <div className="page-title">Finance Intel</div>
        </div>
        <div className="loading-dim">loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="page-header">
          <div className="page-title">Finance Intel</div>
        </div>
        <div className="loading-dim error">{error}</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Finance Intel</div>
      </div>

      {/* Stats Overview */}
      {stats && (
        <div className="stat-row">
          <div className="stat-item">
            <div className="stat-val"><AnimatedNumber value={stats.runCount} /></div>
            <div className="stat-lbl">runs</div>
          </div>
          <div className="stat-item">
            <div className="stat-val"><AnimatedNumber value={stats.enrichmentCount} /></div>
            <div className="stat-lbl">enrichments</div>
          </div>
          <div className="stat-item">
            <div className="stat-val"><AnimatedNumber value={stats.configCount} /></div>
            <div className="stat-lbl">portfolios</div>
          </div>
          <div className="stat-item">
            <div className="stat-val"><AnimatedNumber value={runs.length > 0 ? Math.round(runs.reduce((sum, run) => sum + (run.duration_ms || 0), 0) / runs.length) : 0} /></div>
            <div className="stat-lbl">avg ms</div>
          </div>
        </div>
      )}

      {/* Main Content Sections */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        {/* Left Column - Run History */}
        <div>
          <SectionCard 
            title={
              <div className="flex items-center gap-2">
                <BarChart size={16} />
                <span>Analysis Run History</span>
              </div>
            }
            defaultOpen={true}
          >
            <div className="section-content">
              <div className="tabs">
                <button 
                  className={activeTab === "runs" ? "tab active" : "tab"}
                  onClick={() => setActiveTab("runs")}
                >
                  Recent Runs
                </button>
                <button 
                  className={activeTab === "enrichments" ? "tab active" : "tab"}
                  onClick={() => setActiveTab("enrichments")}
                >
                  Enrichments
                </button>
                <button 
                  className={activeTab === "configs" ? "tab active" : "tab"}
                  onClick={() => setActiveTab("configs")}
                >
                  Portfolios
                </button>
              </div>

              {activeTab === "runs" && (
                <div>
                  <TableControls {...runsCtrl.controlsProps} searchPlaceholder="Search runs..." />
                  <div className="table-container">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th {...runsCtrl.sortHeaderProps("run_at")}>Date <span className="sortable-th-arrow">{runsCtrl.sort.key === "run_at" ? (runsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th>ID</th>
                          <th {...runsCtrl.sortHeaderProps("duration_ms")}>Duration <span className="sortable-th-arrow">{runsCtrl.sort.key === "duration_ms" ? (runsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th {...runsCtrl.sortHeaderProps("model_used")}>Model <span className="sortable-th-arrow">{runsCtrl.sort.key === "model_used" ? (runsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th {...runsCtrl.sortHeaderProps("status")}>Status <span className="sortable-th-arrow">{runsCtrl.sort.key === "status" ? (runsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th {...runsCtrl.sortHeaderProps("insights_count")}>Insights <span className="sortable-th-arrow">{runsCtrl.sort.key === "insights_count" ? (runsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {runsCtrl.rows.map(run => (
                          <tr key={run.id}>
                            <td>{new Date(run.run_at).toLocaleString()}</td>
                            <td className="mono text-xs">{run.id.substring(0, 8)}</td>
                            <td>{run.duration_ms ? `${run.duration_ms}ms` : "-"}</td>
                            <td className="mono text-xs">{run.model_used}</td>
                            <td>
                              <span className={`status-badge ${run.status === "success" ? "success" : "error"}`}>
                                {run.status}
                              </span>
                            </td>
                            <td>{run.insights_count || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === "enrichments" && (
                <div>
                  <TableControls {...enrichmentsCtrl.controlsProps} searchPlaceholder="Search enrichments..." />
                  <div className="table-container">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Article</th>
                          <th {...enrichmentsCtrl.sortHeaderProps("run_at")}>Date <span className="sortable-th-arrow">{enrichmentsCtrl.sort.key === "run_at" ? (enrichmentsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th {...enrichmentsCtrl.sortHeaderProps("model_used")}>Model <span className="sortable-th-arrow">{enrichmentsCtrl.sort.key === "model_used" ? (enrichmentsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th {...enrichmentsCtrl.sortHeaderProps("tickers_extracted")}>Tickers <span className="sortable-th-arrow">{enrichmentsCtrl.sort.key === "tickers_extracted" ? (enrichmentsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th {...enrichmentsCtrl.sortHeaderProps("confidence")}>Confidence <span className="sortable-th-arrow">{enrichmentsCtrl.sort.key === "confidence" ? (enrichmentsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th {...enrichmentsCtrl.sortHeaderProps("status")}>Status <span className="sortable-th-arrow">{enrichmentsCtrl.sort.key === "status" ? (enrichmentsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {enrichmentsCtrl.rows.map(enrichment => (
                          <tr key={enrichment.id}>
                            <td className="truncate max-w-xs" title={enrichment.article_slug}>
                              {enrichment.article_slug.substring(0, 20)}...
                            </td>
                            <td>{new Date(enrichment.run_at).toLocaleString()}</td>
                            <td className="mono text-xs">{enrichment.model_used}</td>
                            <td>{enrichment.tickers_extracted ? JSON.parse(enrichment.tickers_extracted).length : 0}</td>
                            <td>{enrichment.confidence ? enrichment.confidence.toFixed(2) : "-"}</td>
                            <td>
                              <span className={`status-badge ${enrichment.status === "ok" ? "success" : "error"}`}>
                                {enrichment.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === "configs" && (
                <div>
                  <TableControls {...configsCtrl.controlsProps} searchPlaceholder="Search portfolios..." />
                  <div className="table-container">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th {...configsCtrl.sortHeaderProps("name")}>Name <span className="sortable-th-arrow">{configsCtrl.sort.key === "name" ? (configsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th {...configsCtrl.sortHeaderProps("risk_tolerance")}>Risk <span className="sortable-th-arrow">{configsCtrl.sort.key === "risk_tolerance" ? (configsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th {...configsCtrl.sortHeaderProps("confidence_threshold")}>Conf <span className="sortable-th-arrow">{configsCtrl.sort.key === "confidence_threshold" ? (configsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                          <th>Watchlist</th>
                          <th {...configsCtrl.sortHeaderProps("created_at")}>Created <span className="sortable-th-arrow">{configsCtrl.sort.key === "created_at" ? (configsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {configsCtrl.rows.map(config => (
                          <tr key={config.id}>
                            <td>{config.name}</td>
                            <td>{config.risk_tolerance}/10</td>
                            <td>{config.confidence_threshold}</td>
                            <td>{JSON.parse(config.watchlist).length}</td>
                            <td>{new Date(config.created_at).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </SectionCard>
        </div>

        {/* Right Column - Configuration Panel */}
        <div>
          <SectionCard 
            title={
              <div className="flex items-center gap-2">
                <PieChart size={16} />
                <span>Portfolio Configuration</span>
              </div>
            }
            defaultOpen={true}
          >
            <div className="section-content">
              <div className="form-group">
                <label>Active Portfolio</label>
                <select className="form-select">
                  {configs.map(config => (
                    <option key={config.id} value={config.id}>{config.name}</option>
                  ))}
                  <option value="">Create New...</option>
                </select>
              </div>
              
              <div className="form-group">
                <label>Risk Tolerance</label>
                <input type="range" min="1" max="10" defaultValue="5" className="form-range" />
                <div className="range-labels">
                  <span>Conservative</span>
                  <span>Moderate</span>
                  <span>Aggressive</span>
                </div>
              </div>
              
              <div className="form-group">
                <label>Confidence Threshold</label>
                <input type="number" step="0.01" min="0" max="1" defaultValue="0.6" className="form-input" />
              </div>
              
              <div className="form-group">
                <label>Timeframe Preference</label>
                <select className="form-select" defaultValue="medium">
                  <option value="short">Short-term (1-7 days)</option>
                  <option value="medium">Medium-term (1-30 days)</option>
                  <option value="long">Long-term (30+ days)</option>
                  <option value="all">All timeframes</option>
                </select>
              </div>
              
              <button className="btn btn-primary w-full">Save Configuration</button>
            </div>
          </SectionCard>

          {/* Manual Trigger Panel */}
          <SectionCard 
            title={
              <div className="flex items-center gap-2">
                <Activity size={16} />
                <span>Manual Trigger</span>
              </div>
            }
            defaultOpen={true}
          >
            <div className="section-content">
              <div className="form-group">
                <label>Analysis Window</label>
                <select className="form-select" defaultValue="14">
                  <option value="7">Last 7 days</option>
                  <option value="14">Last 14 days</option>
                  <option value="30">Last 30 days</option>
                </select>
              </div>
              
              <div className="form-group">
                <label>Model Selection</label>
                <select className="form-select" defaultValue="editorial-fast">
                  <option value="editorial-heavy">Gemma4 26B (Heavy)</option>
                  <option value="editorial-fast">Gemma4 26B (Fast)</option>
                  <option value="cloud-heavy">DeepSeek V3 (Cloud)</option>
                </select>
              </div>
              
              <button className="btn btn-success w-full">
                <TrendingUp size={16} />
                Run Analysis
              </button>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}