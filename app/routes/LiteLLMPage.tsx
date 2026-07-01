import { useState } from "react";
import { AlertCircle, CheckCircle2, Power, RefreshCw } from "lucide-react";
import { ConfirmModal } from "../components/ConfirmModal";
import { SectionCard } from "../components/SectionCard";
import { useAction } from "../hooks/useAction";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { useTableControls } from "../hooks/useTableControls";
import { TableControls } from "../components/TableControls";

type LiteLLMStatus = {
  service: {
    activeState: string;
    subState: string;
    mainPid: number | null;
    startedAt: string | null;
    memoryBytes: number | null;
    restarts: number | null;
    unitPath: string | null;
  };
  proxy: {
    url: string;
    reachable: boolean;
    healthStatus: number | null;
    healthOk: boolean;
    modelsStatus: number | null;
    modelCount: number | null;
    latencyMs: number | null;
    authConfigured: boolean;
    authRequired: boolean;
    error: string | null;
  };
  config: {
    path: string;
    exists: boolean;
    modelCount: number;
    fallbackChainCount: number;
  };
};

type LiteLLMConfig = {
  path: string;
  exists: boolean;
  lineCount: number;
  modelCount: number;
  redactedYaml: string;
};

type LiteLLMRouting = {
  modelCount: number;
  models: Array<{
    name: string;
    backendModel: string | null;
    apiBase: string | null;
    provider: string;
    timeoutSeconds: number | null;
    hasApiKeyRef: boolean;
    fallbackCount: number;
  }>;
  fallbacks: Array<{ model: string; fallbacks: string[] }>;
};

function pillClass(ok: boolean): string {
  return `pill ${ok ? "green" : "red"}`;
}

function bytes(value: number | null): string {
  if (value == null) return "-";
  if (value > 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function latency(value: number | null): string {
  if (value == null) return "-";
  return value > 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

export function LiteLLMPage() {
  const { data: status, loading: statusLoading, error: statusError, refresh: refreshStatus } = useAuthenticatedApi<LiteLLMStatus>("/api/litellm/status", 20_000);
  const { data: routing, error: routingError, refresh: refreshRouting } = useAuthenticatedApi<LiteLLMRouting>("/api/litellm/routing", 30_000);
  const { data: config, error: configError, refresh: refreshConfig } = useAuthenticatedApi<LiteLLMConfig>("/api/litellm/config", 60_000);
  const restartAction = useAction("/api/actions/execute");
  const [restartOpen, setRestartOpen] = useState(false);

  const refresh = () => {
    refreshStatus();
    refreshRouting();
    refreshConfig();
  };

  const fallbackMap = new Map((routing?.fallbacks ?? []).map((chain) => [chain.model, chain.fallbacks]));
  const errors = [statusError, routingError, configError].filter(Boolean);

  type ModelSortKey = "name" | "provider" | "backendModel" | "timeoutSeconds" | "fallbackCount";
  const modelsCtrl = useTableControls<NonNullable<LiteLLMRouting["models"][0]>, ModelSortKey>({
    rows: routing?.models ?? [],
    defaultSort: { key: "name", dir: "asc" },
    filterText: (m) => [m.name, m.provider, m.backendModel],
    sortValue: (m, key) => {
      if (key === "name") return m.name;
      if (key === "provider") return m.provider;
      if (key === "backendModel") return m.backendModel;
      if (key === "timeoutSeconds") return m.timeoutSeconds;
      if (key === "fallbackCount") return m.fallbackCount;
      return null;
    },
  });

  return (
    <div className="dash-page">
      {restartOpen && (
        <ConfirmModal
          title="Restart litellm.service?"
          message="This will restart the LiteLLM proxy through the audited action executor. Model routing may be briefly unavailable."
          inputLabel="Reason"
          inputPlaceholder="e.g. reload routing after config verification"
          confirmLabel="Restart"
          danger={true}
          loading={restartAction.loading}
          error={restartAction.error}
          onCancel={() => { setRestartOpen(false); restartAction.reset(); }}
          onConfirm={async (reason) => {
            const ok = await restartAction.run({
              actionId: "start-job:service:litellm:restart",
              confirmed: true,
              reason,
            });
            if (ok) {
              setRestartOpen(false);
              setTimeout(refresh, 1200);
            }
          }}
        />
      )}

      <div className="litellm-header">
        <h1>LiteLLM</h1>
        <span className="litellm-proxy-url">
          {status?.proxy.url ?? "loading..."}
        </span>
        <div className="litellm-header-actions">
        <button
          type="button"
          onClick={() => setRestartOpen(true)}
          className="btn btn-danger btn-sm"
        >
          <Power size={13} />
          Restart
        </button>
        <button
          type="button"
          onClick={refresh}
          className="btn btn-ghost btn-sm"
        >
          <RefreshCw size={13} />
          Refresh
        </button>
        </div>
      </div>

      {restartAction.success && (
        <div className="litellm-alert ok">
          {restartAction.success}
        </div>
      )}

      {errors.length > 0 && (
        <div className="litellm-alert error">
          {errors.join(" | ")}
        </div>
      )}

      <div className="litellm-summary-grid">
        {[
          { label: "Service", value: status?.service.activeState ?? (statusLoading ? "loading" : "unknown"), ok: status?.service.activeState === "active" },
          { label: "Proxy", value: status?.proxy.reachable ? "reachable" : "unreachable", ok: Boolean(status?.proxy.reachable) },
          { label: "Models", value: String(status?.proxy.modelCount ?? status?.config.modelCount ?? "-"), ok: Boolean((status?.proxy.modelCount ?? status?.config.modelCount ?? 0) > 0) },
          { label: "Fallback Chains", value: String(status?.config.fallbackChainCount ?? routing?.fallbacks.length ?? "-"), ok: Boolean((status?.config.fallbackChainCount ?? routing?.fallbacks.length ?? 0) > 0) },
        ].map((item) => (
          <div key={item.label} className="litellm-summary-card">
            <div className="litellm-summary-label">
              <span>{item.label}</span>
              {item.ok ? <CheckCircle2 size={14} style={{ color: "var(--green)" }} /> : <AlertCircle size={14} style={{ color: "var(--amber-warn)" }} />}
            </div>
            <div className="litellm-summary-value">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="litellm-main-grid">
        <SectionCard title="Status">
          <div className="litellm-kv-list">
            <div className="litellm-kv-row">
              <span>Unit</span>
              <span className={pillClass(status?.service.activeState === "active")}>{status?.service.activeState ?? "unknown"}</span>
            </div>
            <div className="litellm-kv-row">
              <span>PID</span>
              <code>{status?.service.mainPid ?? "-"}</code>
            </div>
            <div className="litellm-kv-row">
              <span>Memory</span>
              <code>{bytes(status?.service.memoryBytes ?? null)}</code>
            </div>
            <div className="litellm-kv-row">
              <span>Health HTTP</span>
              <code>{status?.proxy.healthStatus ?? "-"}</code>
            </div>
            <div className="litellm-kv-row">
              <span>Latency</span>
              <code>{latency(status?.proxy.latencyMs ?? null)}</code>
            </div>
            <div className="litellm-kv-row">
              <span>Master Key</span>
              <span className={pillClass(Boolean(status?.proxy.authConfigured))}>{status?.proxy.authConfigured ? "configured" : "missing"}</span>
            </div>
            {status?.proxy.error && (
              <div className="litellm-inline-error">{status.proxy.error}</div>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Fallback Chains">
          {(routing?.fallbacks.length ?? 0) === 0 ? (
            <p className="litellm-empty-copy">No fallback chains found in the LiteLLM config.</p>
          ) : (
            <div className="litellm-chain-list">
              {routing?.fallbacks.slice(0, 8).map((chain) => (
                <div key={chain.model} className="litellm-chain-row">
                  <code>{chain.model}</code>
                  <span>{chain.fallbacks.join(" -> ")}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Configured Models">
        <div className="table-wrap">
          <TableControls {...modelsCtrl.controlsProps} searchPlaceholder="Filter models…" />
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th {...modelsCtrl.sortHeaderProps("name")}>Name <span className="sortable-th-arrow">{modelsCtrl.sort.key === "name" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...modelsCtrl.sortHeaderProps("provider")}>Provider <span className="sortable-th-arrow">{modelsCtrl.sort.key === "provider" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...modelsCtrl.sortHeaderProps("backendModel")}>Backend <span className="sortable-th-arrow">{modelsCtrl.sort.key === "backendModel" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...modelsCtrl.sortHeaderProps("timeoutSeconds")} style={{ textAlign: "right" }}>Timeout <span className="sortable-th-arrow">{modelsCtrl.sort.key === "timeoutSeconds" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...modelsCtrl.sortHeaderProps("fallbackCount")} style={{ textAlign: "right" }}>Fallbacks <span className="sortable-th-arrow">{modelsCtrl.sort.key === "fallbackCount" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                </tr>
              </thead>
              <tbody>
                {modelsCtrl.rows.map((model) => (
                  <tr key={model.name}>
                    <td style={{ fontFamily: "var(--mono)" }}>{model.name}</td>
                    <td><span className="pill">{model.provider}</span></td>
                    <td style={{ fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{model.backendModel ?? "-"}</td>
                    <td style={{ textAlign: "right" }}>{model.timeoutSeconds ?? "-"}</td>
                    <td style={{ textAlign: "right" }} title={(fallbackMap.get(model.name) ?? []).join(" -> ")}>
                      {model.fallbackCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Redacted Config">
        <div className="litellm-config-meta">
          <code>{config?.path ?? status?.config.path ?? "-"}</code>
          <span>{config?.lineCount ?? "-"} lines</span>
        </div>
        <pre className="litellm-config-block">
          {config?.redactedYaml || "No config loaded."}
        </pre>
      </SectionCard>
    </div>
  );
}
