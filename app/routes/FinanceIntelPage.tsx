import { useState, useEffect } from "react";
import { SectionCard } from "../components/SectionCard.tsx";
import { AnimatedNumber } from "../components/AnimatedCharts.tsx";
import { TrendingUp, BarChart, PieChart, Activity, Clock, Database } from "lucide-react";
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

export function FinanceIntelPage() {
  const [activeTab, setActiveTab] = useState<"runs" | "enrichments" | "configs">("runs");
  const [stats, setStats] = useState<Stats | null>(null);
  const [runs, setRuns] = useState<FinanceRun[]>([]);
  const [enrichments, setEnrichments] = useState<FinanceEnrichment[]>([]);
  const [configs, setConfigs] = useState<PortfolioConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          <h1><TrendingUp size={20} /> Finance Intelligence Observatory</h1>
          <p>Real-time visibility into financial analysis pipelines</p>
        </div>
        <div className="loading">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="page-header">
          <h1><TrendingUp size={20} /> Finance Intelligence Observatory</h1>
          <p>Real-time visibility into financial analysis pipelines</p>
        </div>
        <div className="error">{error}</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1><TrendingUp size={20} /> Finance Intelligence Observatory</h1>
        <p>Real-time visibility into financial analysis pipelines</p>
      </div>

      {/* Stats Overview */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="stat-card">
            <div className="stat-icon bg-blue-100 text-blue-600">
              <Activity size={18} />
            </div>
            <div className="stat-content">
              <div className="stat-value">
                <AnimatedNumber value={stats.runCount} />
              </div>
              <div className="stat-label">Analysis Runs</div>
            </div>
          </div>
          
          <div className="stat-card">
            <div className="stat-icon bg-green-100 text-green-600">
              <Database size={18} />
            </div>
            <div className="stat-content">
              <div className="stat-value">
                <AnimatedNumber value={stats.enrichmentCount} />
              </div>
              <div className="stat-label">Enrichments</div>
            </div>
          </div>
          
          <div className="stat-card">
            <div className="stat-icon bg-purple-100 text-purple-600">
              <PieChart size={18} />
            </div>
            <div className="stat-content">
              <div className="stat-value">
                <AnimatedNumber value={stats.configCount} />
              </div>
              <div className="stat-label">Portfolios</div>
            </div>
          </div>
          
          <div className="stat-card">
            <div className="stat-icon bg-orange-100 text-orange-600">
              <Clock size={18} />
            </div>
            <div className="stat-content">
              <div className="stat-value">
                <AnimatedNumber value={runs.length > 0 ? Math.round(runs.reduce((sum, run) => sum + (run.duration_ms || 0), 0) / runs.length) : 0} />
              </div>
              <div className="stat-label">Avg Duration (ms)</div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Sections */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Run History */}
        <div className="lg:col-span-2">
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
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Date</th>
                        <th>Duration</th>
                        <th>Model</th>
                        <th>Status</th>
                        <th>Insights</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.slice(0, 10).map(run => (
                        <tr key={run.id}>
                          <td className="mono text-xs">{run.id.substring(0, 8)}</td>
                          <td>{new Date(run.run_at).toLocaleTimeString()}</td>
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
              )}

              {activeTab === "enrichments" && (
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Article</th>
                        <th>Date</th>
                        <th>Model</th>
                        <th>Tickers</th>
                        <th>Confidence</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enrichments.slice(0, 10).map(enrichment => (
                        <tr key={enrichment.id}>
                          <td className="truncate max-w-xs" title={enrichment.article_slug}>
                            {enrichment.article_slug.substring(0, 20)}...
                          </td>
                          <td>{new Date(enrichment.run_at).toLocaleTimeString()}</td>
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
              )}

              {activeTab === "configs" && (
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Risk Tolerance</th>
                        <th>Confidence Threshold</th>
                        <th>Watchlist Size</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {configs.map(config => (
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
              )}
            </div>
          </SectionCard>
        </div>

        {/* Right Column - Configuration Panel */}
        <div className="lg:col-span-1">
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
                <select className="form-select">
                  <option value="short">Short-term (1-7 days)</option>
                  <option value="medium" selected>Medium-term (1-30 days)</option>
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
                <select className="form-select">
                  <option value="7">Last 7 days</option>
                  <option value="14" selected>Last 14 days</option>
                  <option value="30">Last 30 days</option>
                </select>
              </div>
              
              <div className="form-group">
                <label>Model Selection</label>
                <select className="form-select">
                  <option value="editorial-heavy">Gemma4 26B (Heavy)</option>
                  <option value="editorial-fast" selected>Gemma4 26B (Fast)</option>
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