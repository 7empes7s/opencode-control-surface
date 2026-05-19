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

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>LiteLLM</h1>
        <span style={{ color: "var(--text-dim)", fontSize: 12, fontFamily: "var(--mono)", minWidth: 0, overflowWrap: "anywhere" }}>
          {status?.proxy.url ?? "loading..."}
        </span>
        <button
          type="button"
          onClick={() => setRestartOpen(true)}
          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid color-mix(in oklch, var(--red) 45%, var(--border))", background: "transparent", color: "var(--red)", cursor: "pointer" }}
        >
          <Power size={13} />
          Restart
        </button>
        <button
          type="button"
          onClick={refresh}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
        >
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>

      {restartAction.success && (
        <div style={{ border: "1px solid var(--green)", color: "var(--green)", borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 12 }}>
          {restartAction.success}
        </div>
      )}

      {errors.length > 0 && (
        <div style={{ border: "1px solid var(--red)", color: "var(--red)", borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 12 }}>
          {errors.join(" | ")}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Service", value: status?.service.activeState ?? (statusLoading ? "loading" : "unknown"), ok: status?.service.activeState === "active" },
          { label: "Proxy", value: status?.proxy.reachable ? "reachable" : "unreachable", ok: Boolean(status?.proxy.reachable) },
          { label: "Models", value: String(status?.proxy.modelCount ?? status?.config.modelCount ?? "-"), ok: Boolean((status?.proxy.modelCount ?? status?.config.modelCount ?? 0) > 0) },
          { label: "Fallback Chains", value: String(status?.config.fallbackChainCount ?? routing?.fallbacks.length ?? "-"), ok: Boolean((status?.config.fallbackChainCount ?? routing?.fallbacks.length ?? 0) > 0) },
        ].map((item) => (
          <div key={item.label} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", background: "var(--bg-card-start)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{item.label}</span>
              {item.ok ? <CheckCircle2 size={14} style={{ color: "var(--green)" }} /> : <AlertCircle size={14} style={{ color: "var(--amber-warn)" }} />}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, fontFamily: "var(--mono)" }}>{item.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)", gap: 20, marginBottom: 20 }}>
        <SectionCard title="Status">
          <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <span style={{ color: "var(--text-dim)" }}>Unit</span>
              <span className={pillClass(status?.service.activeState === "active")}>{status?.service.activeState ?? "unknown"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <span style={{ color: "var(--text-dim)" }}>PID</span>
              <span style={{ fontFamily: "var(--mono)" }}>{status?.service.mainPid ?? "-"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <span style={{ color: "var(--text-dim)" }}>Memory</span>
              <span style={{ fontFamily: "var(--mono)" }}>{bytes(status?.service.memoryBytes ?? null)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <span style={{ color: "var(--text-dim)" }}>Health HTTP</span>
              <span style={{ fontFamily: "var(--mono)" }}>{status?.proxy.healthStatus ?? "-"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <span style={{ color: "var(--text-dim)" }}>Latency</span>
              <span style={{ fontFamily: "var(--mono)" }}>{latency(status?.proxy.latencyMs ?? null)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <span style={{ color: "var(--text-dim)" }}>Master Key</span>
              <span className={pillClass(Boolean(status?.proxy.authConfigured))}>{status?.proxy.authConfigured ? "configured" : "missing"}</span>
            </div>
            {status?.proxy.error && (
              <div style={{ color: "var(--red)", fontSize: 11 }}>{status.proxy.error}</div>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Fallback Chains">
          {(routing?.fallbacks.length ?? 0) === 0 ? (
            <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 12 }}>No fallback chains found in the LiteLLM config.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {routing?.fallbacks.slice(0, 8).map((chain) => (
                <div key={chain.model} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 12, marginBottom: 4 }}>{chain.model}</div>
                  <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>{chain.fallbacks.join(" -> ")}</div>
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
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 8, fontSize: 11, color: "var(--text-dim)" }}>
          <span style={{ fontFamily: "var(--mono)" }}>{config?.path ?? status?.config.path ?? "-"}</span>
          <span>{config?.lineCount ?? "-"} lines</span>
        </div>
        <pre style={{ maxHeight: 360, overflow: "auto", margin: 0, padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
          {config?.redactedYaml || "No config loaded."}
        </pre>
      </SectionCard>
    </div>
  );
}
