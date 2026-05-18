import { useState, useEffect } from "react";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";
import { SectionCard } from "../components/SectionCard";
import type { LiteLLMRoutingLogEntry, LiteLLMRoutingStats } from "../../server/api/types";

// Simple model picker component
function ModelPicker({ 
  label, 
  value, 
  onChange, 
  options,
  placeholder
}: { 
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const filteredOptions = options.filter(option => 
    option.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          className="form-input"
          required
        />
        {isOpen && (
          <div className="absolute z-10 mt-1 w-full bg-[var(--bg-card-start)] border border-[var(--border)] rounded shadow-lg max-h-60 overflow-auto">
            <input
              type="text"
              placeholder="Filter options..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="form-input w-full sticky top-0"
            />
            <div className="py-1">
              {filteredOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`block w-full text-left px-4 py-2 text-sm hover:bg-[var(--bg-hover)] ${
                    value === option ? "bg-[var(--bg-hover)]" : ""
                  }`}
                  onClick={() => {
                    onChange(option);
                    setIsOpen(false);
                    setFilter("");
                  }}
                >
                  {option}
                </button>
              ))}
              {filteredOptions.length === 0 && (
                <div className="px-4 py-2 text-sm text-[var(--text-dim)]">No matching options</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString();
}

function StatusPill({ status }: { status: string }) {
  let color = "gray";
  if (status === "ok") color = "green";
  else if (status === "fallback") color = "amber";
  else if (status === "failed") color = "red";
  
  return <span className={`pill ${color}`}>{status}</span>;
}

interface ForceRouteFormProps {
  onForceRoute: (logicalName: string, targetModel: string, reason: string) => void;
  loading: boolean;
  logicalNames: string[];
  targetModels: string[];
}

function ForceRouteForm({ onForceRoute, loading, logicalNames, targetModels }: ForceRouteFormProps) {
  const [logicalName, setLogicalName] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [reason, setReason] = useState("Manual override");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onForceRoute(logicalName, targetModel, reason);
  };

  return (
    <form onSubmit={handleSubmit} className="form-grid" style={{ gap: "12px", maxWidth: "600px" }}>
      <ModelPicker
        label="Logical Name"
        value={logicalName}
        onChange={setLogicalName}
        options={logicalNames}
        placeholder="e.g., editorial-heavy, coding-fast"
      />
      <ModelPicker
        label="Target Model"
        value={targetModel}
        onChange={setTargetModel}
        options={targetModels}
        placeholder="e.g., openrouter/deepseek/deepseek-v3:free"
      />
      <div>
        <label className="form-label">Reason</label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="form-input"
        />
      </div>
      <div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? "Setting..." : "Force Route"}
        </button>
      </div>
    </form>
  );
}

interface RoutingInspectorProps {
  onForceRouteMessage: (type: "success" | "error", text: string) => void;
}

export function RoutingInspector({ onForceRouteMessage }: RoutingInspectorProps) {
  const [activeTab, setActiveTab] = useState<"logs" | "stats" | "controls">("logs");
  
  const { 
    data: logsData, 
    loading: logsLoading, 
    error: logsError, 
    refresh: refreshLogs 
  } = useApi<{ data: LiteLLMRoutingLogEntry[], pagination: any }>("/api/models/routing-log?limit=50", 10_000);
  
  const { 
    data: statsData, 
    loading: statsLoading, 
    error: statsError, 
    refresh: refreshStats 
  } = useApi<{ data: LiteLLMRoutingStats[], summary: any }>("/api/models/routing-stats", 30_000);

  // Fetch model data for pickers
  const { data: modelsData } = useApi<{ data: { models: { logicalName: string }[] } }>("/api/models", 0);
  const { data: gatewayModelsData } = useApi<{ data: { models: { id: string }[] } }>("/api/gateway/models", 0);

  // Extract unique logical names and target models
  const logicalNames = [...new Set(modelsData?.data?.models?.map(m => m.logicalName) || [])].sort();
  const targetModels = [...new Set(gatewayModelsData?.data?.models?.map(m => m.id) || [])].sort();

  const handleForceRoute = async (logicalName: string, targetModel: string, reason: string) => {
    try {
      const response = await authFetch("/api/models/force-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logicalName, targetModel, reason })
      });
      
      const result = await response.json();
      if (result.success) {
        onForceRouteMessage("success", result.message);
        setTimeout(() => onForceRouteMessage(null as any, ""), 5000); // Clear message after 5 seconds
      } else {
        onForceRouteMessage("error", result.error || "Unknown error");
      }
    } catch (err) {
      onForceRouteMessage("error", "Network error occurred");
    }
  };

  const handleClearForceRoute = async (logicalName: string) => {
    try {
      const response = await authFetch(`/api/models/force-route/${logicalName}`, {
        method: "DELETE"
      });
      
      const result = await response.json();
      if (result.success) {
        onForceRouteMessage("success", result.message);
        setTimeout(() => onForceRouteMessage(null as any, ""), 5000); // Clear message after 5 seconds
        refreshStats(); // Refresh stats after clearing
      } else {
        onForceRouteMessage("error", result.error || "Unknown error");
      }
    } catch (err) {
      onForceRouteMessage("error", "Network error occurred");
    }
  };

  const logs = logsData?.data || [];
  const stats = statsData?.data || [];

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">LiteLLM Routing Inspector</div>
        <div className="tab-nav">
          <button 
            className={`tab-btn ${activeTab === "logs" ? "active" : ""}`} 
            onClick={() => setActiveTab("logs")}
          >
            Routing Logs
          </button>
          <button 
            className={`tab-btn ${activeTab === "stats" ? "active" : ""}`} 
            onClick={() => setActiveTab("stats")}
          >
            Model Stats
          </button>
          <button 
            className={`tab-btn ${activeTab === "controls" ? "active" : ""}`} 
            onClick={() => setActiveTab("controls")}
          >
            Route Controls
          </button>
        </div>
      </div>

      {activeTab === "logs" && (
        <SectionCard title="Recent Routing Logs" defaultOpen={true}>
          <div className="section-card-body">
            {logsLoading && !logs.length ? (
              <div className="loading-dim">Loading routing logs...</div>
            ) : logsError ? (
              <div className="loading-dim error">Error loading logs: {logsError}</div>
            ) : logs.length === 0 ? (
              <div className="loading-dim">No routing logs available</div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Logical Name</th>
                      <th>Final Model</th>
                      <th>Status</th>
                      <th>Latency</th>
                      <th>Prompt Tokens</th>
                      <th>Try Chain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={`${log.id}-${log.loggedAt}`}>
                        <td className="mono dim">{fmtTime(log.loggedAt)}</td>
                        <td className="mono">{log.logicalName}</td>
                        <td className="mono">{log.finalModel || "—"}</td>
                        <td><StatusPill status={log.status} /></td>
                        <td className="mono">{fmtLatency(log.totalLatencyMs)}</td>
                        <td className="mono">{log.promptTokens || "—"}</td>
                        <td className="mono">
                          {((typeof log.triedModels === 'string') ? 
                            (log.triedModels ? JSON.parse(log.triedModels) : []) : 
                            (log.triedModels || [])
                          ).map((attempt: any, idx: number) => (
                            <div key={idx} className="try-chain-item">
                              <span className={`try-status ${attempt.status === "success" ? "success" : attempt.status === "failed" ? "error" : "fallback"}`}>
                                {attempt.model}
                              </span>
                              {attempt.latencyMs && <span className="dim"> ({fmtLatency(attempt.latencyMs)})</span>}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {activeTab === "stats" && (
        <SectionCard title="Model Routing Statistics" defaultOpen={true}>
          <div className="section-card-body">
            {statsLoading && !stats.length ? (
              <div className="loading-dim">Loading statistics...</div>
            ) : statsError ? (
              <div className="loading-dim error">Error loading stats: {statsError}</div>
            ) : stats.length === 0 ? (
              <div className="loading-dim">No routing statistics available</div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Total Requests</th>
                      <th>Success Rate</th>
                      <th>Avg Latency</th>
                      <th>Fallback Rate</th>
                      <th>Failure Rate</th>
                      <th>Avg Prompt Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.map((stat) => {
                      const successRate = stat.totalRequests > 0 ? (stat.successCount / stat.totalRequests * 100).toFixed(1) : "0";
                      const fallbackRate = stat.totalRequests > 0 ? (stat.fallbackCount / stat.totalRequests * 100).toFixed(1) : "0";
                      const failureRate = stat.totalRequests > 0 ? (stat.failedCount / stat.totalRequests * 100).toFixed(1) : "0";
                      
                      return (
                        <tr key={stat.logicalName}>
                          <td className="mono">{stat.logicalName}</td>
                          <td className="mono">{stat.totalRequests}</td>
                          <td className="mono">{successRate}%</td>
                          <td className="mono">{fmtLatency(stat.avgLatencyMs)}</td>
                          <td className="mono">{fallbackRate}%</td>
                          <td className="mono">{failureRate}%</td>
                          <td className="mono">{stat.avgPromptTokens || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {activeTab === "controls" && (
        <div style={{ display: "grid", gap: "24px" }}>
          <SectionCard title="Force Model Routing" defaultOpen={true}>
            <div className="section-card-body">
              <p className="section-help">
                Temporarily force a logical model name to always resolve to a specific target model.
                This bypasses fallback chains and forces the specific model to be used.
              </p>
              
              <ForceRouteForm 
                onForceRoute={handleForceRoute} 
                loading={false} // We handle loading state internally
                logicalNames={logicalNames}
                targetModels={targetModels}
              />
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  );
}