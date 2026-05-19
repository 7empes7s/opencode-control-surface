import { useState } from "react";
import { AlertCircle, Bot, CheckCircle2, Power, RefreshCw } from "lucide-react";
import { ConfirmModal } from "../components/ConfirmModal";
import { SectionCard } from "../components/SectionCard";
import { useAction } from "../hooks/useAction";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { useTableControls } from "../hooks/useTableControls";
import { TableControls } from "../components/TableControls";

type PaperclipAgent = {
  id: string;
  name: string;
  role: string | null;
  adapterType: string | null;
  command: string | null;
  model: string | null;
  status: string;
  lastRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
};

type PaperclipTask = {
  id: string;
  agentId: string | null;
  agentName: string | null;
  status: string;
  priority: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

type AdapterHealth = {
  adapterType: string;
  totalAgents: number;
  activeAgents: number;
  errorAgents: number;
  statuses: Record<string, number>;
};

type AgentsResponse = {
  source: string;
  apiUrl: string;
  generatedAt: string;
  agents: PaperclipAgent[];
  adapterHealth: AdapterHealth[];
  errors: string[];
};

type TasksResponse = {
  source: string;
  apiUrl: string;
  generatedAt: string;
  tasks: PaperclipTask[];
  summary: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  errors: string[];
};

function statusClass(status: string): string {
  if (/fail|error|offline|cancel/i.test(status)) return "pill red";
  if (/pending|queued|waiting/i.test(status)) return "pill amber";
  if (/running|busy|active|started/i.test(status)) return "pill blue";
  if (/idle|online|ok|complete|success|done|finished/i.test(status)) return "pill green";
  return "pill";
}

function when(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function sourceLabel(agentsSource: string | undefined, tasksSource: string | undefined): string {
  const sources = [agentsSource, tasksSource].filter(Boolean);
  return sources.length ? [...new Set(sources)].join(" / ") : "loading";
}

export function PaperclipPage() {
  const { data: agentsData, loading: agentsLoading, error: agentsError, refresh: refreshAgents } = useAuthenticatedApi<AgentsResponse>("/api/paperclip/agents", 20_000);
  const { data: tasksData, loading: tasksLoading, error: tasksError, refresh: refreshTasks } = useAuthenticatedApi<TasksResponse>("/api/paperclip/tasks", 20_000);
  const restartAction = useAction("/api/actions/execute");
  const [restartOpen, setRestartOpen] = useState(false);

  const refresh = () => {
    refreshAgents();
    refreshTasks();
  };

  const agents = agentsData?.agents ?? [];
  const tasks = tasksData?.tasks ?? [];
  const summary = tasksData?.summary;
  const adapterErrors = agentsData?.adapterHealth.reduce((sum, adapter) => sum + adapter.errorAgents, 0) ?? 0;
  const errors = [agentsError, tasksError, ...(agentsData?.errors ?? []), ...(tasksData?.errors ?? [])].filter(Boolean);

  type AgentSortKey = "name" | "status" | "lastRunAt" | "consecutiveFailures";
  const agentsCtrl = useTableControls<PaperclipAgent, AgentSortKey>({
    rows: agents,
    defaultSort: { key: "status", dir: "asc" },
    filterText: (row) => [row.name, row.role, row.model, row.adapterType, row.status],
    sortValue: (row, key) => {
      if (key === "name") return row.name;
      if (key === "status") return row.status;
      if (key === "lastRunAt") return row.lastRunAt ? new Date(row.lastRunAt) : null;
      if (key === "consecutiveFailures") return row.consecutiveFailures;
      return null;
    },
  });

  type TaskSortKey = "id" | "status" | "priority" | "startedAt" | "finishedAt";
  const tasksCtrl = useTableControls<PaperclipTask, TaskSortKey>({
    rows: tasks,
    defaultSort: { key: "startedAt", dir: "desc" },
    filterText: (row) => [row.id, row.agentName, row.status, row.priority, row.error],
    sortValue: (row, key) => {
      if (key === "id") return row.id;
      if (key === "status") return row.status;
      if (key === "priority") return row.priority;
      if (key === "startedAt") return row.startedAt ? new Date(row.startedAt) : null;
      if (key === "finishedAt") return row.finishedAt ? new Date(row.finishedAt) : null;
      return null;
    },
  });

  return (
    <div className="dash-page">
      {restartOpen && (
        <ConfirmModal
          title="Restart paperclip container?"
          message="This uses the audited action executor to restart the Paperclip container. Active Paperclip tasks may be interrupted."
          inputLabel="Reason"
          inputPlaceholder="e.g. recover stalled Paperclip adapter"
          confirmLabel="Restart"
          danger={true}
          loading={restartAction.loading}
          error={restartAction.error}
          onCancel={() => { setRestartOpen(false); restartAction.reset(); }}
          onConfirm={async (reason) => {
            const ok = await restartAction.run({
              actionId: "start-job:service:paperclip:restart",
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
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Paperclip</h1>
        <span style={{ color: "var(--text-dim)", fontSize: 12, fontFamily: "var(--mono)", minWidth: 0, overflowWrap: "anywhere" }}>
          {agentsData?.apiUrl ?? tasksData?.apiUrl ?? "loading..."}
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
        <div style={{ border: "1px solid var(--amber-warn)", color: "var(--amber-warn)", borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 12 }}>
          {errors.join(" | ")}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Agents", value: agentsLoading ? "loading" : String(agents.length), ok: agents.length > 0 },
          { label: "Active Adapters", value: String(agentsData?.adapterHealth.reduce((sum, adapter) => sum + adapter.activeAgents, 0) ?? 0), ok: adapterErrors === 0 },
          { label: "Running Tasks", value: String(summary?.running ?? (tasksLoading ? "loading" : 0)), ok: (summary?.failed ?? 0) === 0 },
          { label: "Source", value: sourceLabel(agentsData?.source, tasksData?.source), ok: agentsData?.source !== "unavailable" && tasksData?.source !== "unavailable" },
        ].map((item) => (
          <div key={item.label} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", background: "var(--bg-card-start)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{item.label}</span>
              {item.ok ? <CheckCircle2 size={14} style={{ color: "var(--green)" }} /> : <AlertCircle size={14} style={{ color: "var(--amber-warn)" }} />}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, fontFamily: "var(--mono)", overflowWrap: "anywhere" }}>{item.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)", gap: 20, marginBottom: 20 }}>
        <SectionCard title="Adapter Health">
          {(agentsData?.adapterHealth.length ?? 0) === 0 ? (
            <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 12 }}>No Paperclip adapters found.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {agentsData?.adapterHealth.map((adapter) => (
                <div key={adapter.adapterType} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{adapter.adapterType}</span>
                    <span className={adapter.errorAgents > 0 ? "pill red" : "pill green"}>{adapter.activeAgents}/{adapter.totalAgents} active</span>
                  </div>
                  <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>
                    {Object.entries(adapter.statuses).map(([status, count]) => `${status}:${count}`).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Task Summary">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8 }}>
            {[
              ["Total", summary?.total ?? 0],
              ["Pending", summary?.pending ?? 0],
              ["Running", summary?.running ?? 0],
              ["Done", summary?.completed ?? 0],
              ["Failed", summary?.failed ?? 0],
            ].map(([label, value]) => (
              <div key={label} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
                <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{label}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 700, marginTop: 4 }}>{value}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Agent Roster">
        <div className="table-wrap">
          <TableControls {...agentsCtrl.controlsProps} searchPlaceholder="Filter agents…" />
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th {...agentsCtrl.sortHeaderProps("name")}>Agent <span className="sortable-th-arrow">{agentsCtrl.sort.key === "name" ? (agentsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th>Adapter</th>
                  <th>Model</th>
                  <th {...agentsCtrl.sortHeaderProps("status")}>Status <span className="sortable-th-arrow">{agentsCtrl.sort.key === "status" ? (agentsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...agentsCtrl.sortHeaderProps("consecutiveFailures")}>Failures <span className="sortable-th-arrow">{agentsCtrl.sort.key === "consecutiveFailures" ? (agentsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...agentsCtrl.sortHeaderProps("lastRunAt")}>Last Run <span className="sortable-th-arrow">{agentsCtrl.sort.key === "lastRunAt" ? (agentsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                </tr>
              </thead>
              <tbody>
                {agentsCtrl.rows.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Bot size={14} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
                        <span style={{ fontWeight: 600 }}>{agent.name}</span>
                      </div>
                      <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 3 }}>{agent.role ?? agent.command ?? agent.id}</div>
                      {agent.lastError && <div style={{ color: "var(--red)", fontSize: 11, marginTop: 3 }}>{agent.lastError}</div>}
                    </td>
                    <td style={{ fontFamily: "var(--mono)" }}>{agent.adapterType ?? "-"}</td>
                    <td style={{ fontFamily: "var(--mono)" }}>{agent.model ?? "-"}</td>
                    <td><span className={statusClass(agent.status)}>{agent.status}</span></td>
                    <td style={{ fontFamily: "var(--mono)" }}>{agent.consecutiveFailures}</td>
                    <td style={{ fontFamily: "var(--mono)" }}>{when(agent.lastRunAt)}</td>
                  </tr>
                ))}
                {agentsCtrl.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ color: "var(--text-dim)" }}>No Paperclip agents available.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Task Ledger" defaultOpen={false} style={{ marginTop: 20 }}>
        <div className="table-wrap">
          <TableControls {...tasksCtrl.controlsProps} searchPlaceholder="Filter tasks…" />
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th {...tasksCtrl.sortHeaderProps("id")}>Task <span className="sortable-th-arrow">{tasksCtrl.sort.key === "id" ? (tasksCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th>Agent</th>
                  <th {...tasksCtrl.sortHeaderProps("priority")}>Priority <span className="sortable-th-arrow">{tasksCtrl.sort.key === "priority" ? (tasksCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...tasksCtrl.sortHeaderProps("status")}>Status <span className="sortable-th-arrow">{tasksCtrl.sort.key === "status" ? (tasksCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...tasksCtrl.sortHeaderProps("startedAt")}>Started <span className="sortable-th-arrow">{tasksCtrl.sort.key === "startedAt" ? (tasksCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...tasksCtrl.sortHeaderProps("finishedAt")}>Finished <span className="sortable-th-arrow">{tasksCtrl.sort.key === "finishedAt" ? (tasksCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                </tr>
              </thead>
              <tbody>
                {tasksCtrl.rows.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{task.id}</div>
                      {task.error && <div style={{ color: "var(--red)", fontSize: 11, marginTop: 3 }}>{task.error}</div>}
                    </td>
                    <td>{task.agentName ?? task.agentId ?? "-"}</td>
                    <td>{task.priority ?? "-"}</td>
                    <td><span className={statusClass(task.status)}>{task.status}</span></td>
                    <td style={{ fontFamily: "var(--mono)" }}>{when(task.startedAt ?? task.createdAt)}</td>
                    <td style={{ fontFamily: "var(--mono)" }}>{when(task.finishedAt)}</td>
                  </tr>
                ))}
                {tasksCtrl.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ color: "var(--text-dim)" }}>No Paperclip tasks available.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
