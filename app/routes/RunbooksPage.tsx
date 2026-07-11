import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GripVertical, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ActionDescriptor } from "../../server/api/types";
import { ConfirmModal } from "../components/ConfirmModal";
import { TableControls } from "../components/TableControls";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { useTableControls } from "../hooks/useTableControls";

type RunbookStep = { actionId: string; params?: Record<string, unknown> };
type Runbook = {
  id: string;
  name: string;
  description: string | null;
  steps: RunbookStep[];
  stepCount: number;
  risk: "medium" | "high";
  validationError: string | null;
  updatedAt: number;
  lastRun: { status: string; startedAt: number } | null;
};
type RunRow = {
  id: string;
  runbook_id: string;
  status: "running" | "success" | "failed";
  actor: string | null;
  reason: string | null;
  risk: string;
  started_at: number;
  finished_at: number | null;
  error: string | null;
};
type RunStepRow = {
  id: string;
  step_index: number;
  action_id: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  message: string | null;
  error: string | null;
};
type DraftStep = { actionId: string; paramsText: string };
type RunbookDraft = { id?: string; name: string; description: string; steps: DraftStep[] };
type SortKey = "name" | "steps" | "lastRun" | "updatedAt";
type HistorySortKey = "status" | "started" | "finished" | "actor";

function statusClass(status: string): string {
  if (status === "success") return "green";
  if (status === "failed" || status === "skipped") return "red";
  if (status === "running") return "blue";
  return "gray";
}

function formatTime(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function paramsText(params?: Record<string, unknown>): string {
  return params && Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : "";
}

function RunHistoryTable({ runs }: { runs: RunRow[] }) {
  const controls = useTableControls<RunRow, HistorySortKey>({
    rows: runs,
    pageSize: 10,
    rowKey: (run) => run.id,
    defaultSort: { key: "started", dir: "desc" },
    filterText: (run) => [run.status, run.actor, run.reason, run.error, run.risk],
    sortValue: (run, key) => {
      if (key === "status") return run.status;
      if (key === "finished") return run.finished_at;
      if (key === "actor") return run.actor;
      return run.started_at;
    },
  });
  if (runs.length === 0) return <div className="empty-state"><strong>No runs yet.</strong><span>Start this runbook to create its first audited run.</span></div>;
  return (
    <div className="table-wrap">
      <TableControls {...controls.controlsProps} searchPlaceholder="Search status, actor, reason, error..." />
      <table className="data-table">
        <thead><tr><th className="expander-col" aria-label="Details"></th><th {...controls.sortHeaderProps("status")}>Status</th><th {...controls.sortHeaderProps("started")}>Started</th><th {...controls.sortHeaderProps("finished")}>Finished</th><th {...controls.sortHeaderProps("actor")}>Actor</th></tr></thead>
        <tbody>
          {controls.rows.map((run) => {
            const expanded = controls.isExpanded(run.id);
            return <Fragment key={run.id}><tr className="data-row-clickable" onClick={() => controls.toggleExpanded(run.id)}><td>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td><td><span className={`pill ${statusClass(run.status)}`}>{run.status}</span></td><td>{formatTime(run.started_at)}</td><td>{formatTime(run.finished_at)}</td><td>{run.actor ?? "operator"}</td></tr>{expanded && <tr className="data-row-detail"><td colSpan={5}><div className="data-row-detail-inner"><div className="data-row-detail-grid"><div><span>Run ID</span><strong>{run.id}</strong></div><div><span>Risk</span><strong>{run.risk}</strong></div><div><span>Reason</span><strong>{run.reason ?? "—"}</strong></div><div><span>Error</span><strong>{run.error ?? "—"}</strong></div></div></div></td></tr>}</Fragment>;
          })}
          {controls.filteredCount === 0 && <tr><td colSpan={5}><div className="empty-state"><strong>No runs match this search.</strong><span>Clear the filter to see the full history.</span></div></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function RunbooksPage() {
  const { data, loading, error, refresh, request } = useAuthenticatedApi<{ runbooks: Runbook[] }>("/api/runbooks", 10_000);
  const { data: catalogData } = useAuthenticatedApi<{ actions: ActionDescriptor[] }>("/api/actions/catalog", 30_000);
  const runbooks = data?.runbooks ?? [];
  const actions = catalogData?.actions ?? [];
  const actionsById = useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);
  const controls = useTableControls<Runbook, SortKey>({
    rows: runbooks,
    pageSize: 10,
    rowKey: (runbook) => runbook.id,
    defaultSort: { key: "updatedAt", dir: "desc" },
    filterText: (runbook) => [runbook.name, runbook.description, runbook.steps.map((step) => step.actionId).join(" "), runbook.lastRun?.status],
    sortValue: (runbook, key) => {
      if (key === "steps") return runbook.stepCount;
      if (key === "lastRun") return runbook.lastRun?.startedAt;
      if (key === "updatedAt") return runbook.updatedAt;
      return runbook.name;
    },
  });
  const [draft, setDraft] = useState<RunbookDraft | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerActionId, setPickerActionId] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [runTarget, setRunTarget] = useState<Runbook | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Runbook | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [activeRun, setActiveRun] = useState<{ runbookId: string; pollUrl: string; run: RunRow | null; steps: RunStepRow[] } | null>(null);
  const [history, setHistory] = useState<Record<string, RunRow[]>>({});

  const pickerActions = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    return actions
      .filter((action) => !query || `${action.id} ${action.label} ${action.risk}`.toLowerCase().includes(query))
      .slice(0, 100);
  }, [actions, pickerQuery]);

  useEffect(() => {
    if (!activeRun?.pollUrl || (activeRun.run && activeRun.run.status !== "running")) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await request(activeRun.pollUrl);
        const body = await response.json() as { data?: { run: RunRow; steps: RunStepRow[] }; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error || `HTTP ${response.status}`);
        if (cancelled) return;
        setActiveRun((current) => current ? { ...current, run: body.data!.run, steps: body.data!.steps } : current);
        if (body.data.run.status !== "running") {
          refresh();
          void loadHistory(activeRun.runbookId);
        }
      } catch (pollError) {
        if (!cancelled) setFeedback(pollError instanceof Error ? pollError.message : String(pollError));
      }
    };
    void poll();
    const timer = setInterval(poll, 1_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.pollUrl, activeRun?.run?.status, request, refresh]);

  async function loadHistory(runbookId: string) {
    const response = await request(`/api/runbooks/${encodeURIComponent(runbookId)}/runs?limit=25`);
    if (!response.ok) return;
    const body = await response.json() as { data: { runs: RunRow[] } };
    setHistory((current) => ({ ...current, [runbookId]: body.data.runs }));
  }

  function toggleRow(runbook: Runbook) {
    controls.toggleExpanded(runbook.id);
    if (!controls.isExpanded(runbook.id) && !history[runbook.id]) void loadHistory(runbook.id);
  }

  function editRunbook(runbook: Runbook) {
    setFeedback(null);
    setDraft({
      id: runbook.id,
      name: runbook.name,
      description: runbook.description ?? "",
      steps: runbook.steps.map((step) => ({ actionId: step.actionId, paramsText: paramsText(step.params) })),
    });
  }

  function addStep() {
    if (!draft || !pickerActionId) return;
    setDraft({ ...draft, steps: [...draft.steps, { actionId: pickerActionId, paramsText: "" }] });
  }

  function moveStep(index: number, direction: -1 | 1) {
    if (!draft) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[nextIndex]] = [steps[nextIndex], steps[index]];
    setDraft({ ...draft, steps });
  }

  async function saveDraft() {
    if (!draft) return;
    setFeedback(null);
    let steps: RunbookStep[];
    try {
      steps = draft.steps.map((step, index) => {
        const text = step.paramsText.trim();
        if (!text) return { actionId: step.actionId };
        const params = JSON.parse(text);
        if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error(`Step ${index + 1} params must be a JSON object.`);
        return { actionId: step.actionId, params };
      });
    } catch (parseError) {
      setFeedback(parseError instanceof Error ? parseError.message : String(parseError));
      return;
    }
    setSaving(true);
    try {
      const path = draft.id ? `/api/runbooks/${encodeURIComponent(draft.id)}` : "/api/runbooks";
      const response = await request(path, {
        method: draft.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draft.name, description: draft.description, steps }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setDraft(null);
      setFeedback(draft.id ? "Runbook updated." : "Runbook created.");
      refresh();
    } catch (saveError) {
      setFeedback(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function startRun(reason?: string) {
    if (!runTarget || !reason) return;
    setRunBusy(true);
    setFeedback(null);
    try {
      const response = await request(`/api/runbooks/${encodeURIComponent(runTarget.id)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, confirmed: true }),
      });
      const body = await response.json() as { runId?: string; pollUrl?: string; error?: string };
      if (!response.ok || !body.runId || !body.pollUrl) throw new Error(body.error || `HTTP ${response.status}`);
      setActiveRun({ runbookId: runTarget.id, pollUrl: body.pollUrl, run: null, steps: [] });
      setRunTarget(null);
      if (!controls.isExpanded(runTarget.id)) controls.toggleExpanded(runTarget.id);
    } catch (runError) {
      setFeedback(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunBusy(false);
    }
  }

  async function archiveRunbook() {
    if (!archiveTarget) return;
    const target = archiveTarget;
    const response = await request(`/api/runbooks/${encodeURIComponent(target.id)}`, { method: "DELETE" });
    const body = await response.json() as { error?: string };
    setArchiveTarget(null);
    if (!response.ok) setFeedback(body.error || `HTTP ${response.status}`);
    else {
      setFeedback(`Archived ${target.name}.`);
      refresh();
    }
  }

  return (
    <div className="dash-page">
      {runTarget && (
        <ConfirmModal
          title={`Run ${runTarget.name}`}
          message={`Risk: ${runTarget.risk.toUpperCase()} · ${runTarget.steps.map((step, index) => `${index + 1}. ${step.actionId}`).join(" · ")}`}
          inputLabel="Reason"
          inputPlaceholder="Why is this bundle being run?"
          confirmLabel="Run sequentially"
          loading={runBusy}
          onCancel={() => setRunTarget(null)}
          onConfirm={(reason) => { void startRun(reason); }}
        />
      )}
      {archiveTarget && (
        <ConfirmModal
          title={`Archive ${archiveTarget.name}?`}
          message="Archived runbooks are hidden and cannot be started. Existing run history remains available in the database."
          confirmLabel="Archive"
          danger
          onCancel={() => setArchiveTarget(null)}
          onConfirm={() => { void archiveRunbook(); }}
        />
      )}

      <section className="dash-section" style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
        <div>
          <div className="dash-section-title">runbooks</div>
          <h1 style={{ margin: "6px 0" }}>Audited action bundles</h1>
          <p className="dim" style={{ margin: 0 }}>Compose catalog actions once, pass parameters, and execute them sequentially with a complete run record.</p>
        </div>
        <div className="button-row">
          <button className="btn secondary" type="button" onClick={refresh}><RefreshCw size={14} /> Refresh</button>
          <button className="btn" type="button" onClick={() => setDraft({ name: "", description: "", steps: [] })}><Plus size={14} /> New runbook</button>
        </div>
      </section>

      {feedback && <div className="loading-panel">{feedback}</div>}
      {loading && !data && <div className="loading-panel">Loading runbooks.</div>}
      {error && !data && <div className="loading-panel error">Runbooks did not load: {error}</div>}

      {draft && (
        <section className="dash-section" style={{ padding: 16, border: "1px solid var(--border)", borderRadius: 8 }}>
          <div className="dash-section-title">{draft.id ? "edit runbook" : "compose runbook"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) minmax(280px, 2fr)", gap: 12, marginTop: 12 }}>
            <label>Name<input className="modal-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Restart and verify" /></label>
            <label>Description<input className="modal-input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="What this bundle does" /></label>
          </div>
          <div style={{ marginTop: 18 }}>
            <div className="dash-section-title">action catalog palette</div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, .8fr) minmax(300px, 2fr) auto", gap: 8, alignItems: "end", marginTop: 8 }}>
              <label>Search<input className="modal-input" value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="Filter id, label, risk" /></label>
              <label>Action<select className="modal-input" value={pickerActionId} onChange={(event) => setPickerActionId(event.target.value)}><option value="">Select an action</option>{pickerActions.map((action) => <option value={action.id} key={action.id}>{action.id} — {action.label} [{action.risk}]</option>)}</select></label>
              <button className="btn" type="button" disabled={!pickerActionId || draft.steps.length >= 20} onClick={addStep}><Plus size={14} /> Add</button>
            </div>
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
            {draft.steps.length === 0 && <div className="empty-state"><strong>No steps yet.</strong><span>Choose 1–20 actions from the current catalog.</span></div>}
            {draft.steps.map((step, index) => {
              const descriptor = actionsById.get(step.actionId);
              return (
                <div key={`${index}-${step.actionId}`} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, display: "grid", gridTemplateColumns: "24px minmax(220px, 1fr) minmax(220px, 1fr) auto", gap: 10, alignItems: "center" }}>
                  <GripVertical size={16} className="dim" />
                  <div><strong>{index + 1}. {descriptor?.label ?? step.actionId}</strong><div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{step.actionId} <span className={`pill ${descriptor ? statusClass(descriptor.risk === "high" ? "failed" : "running") : "red"}`}>{descriptor?.risk ?? "missing"}</span></div></div>
                  <label>Params JSON<textarea className="modal-input" rows={2} value={step.paramsText} onChange={(event) => { const steps = [...draft.steps]; steps[index] = { ...step, paramsText: event.target.value }; setDraft({ ...draft, steps }); }} placeholder="{} (optional)" /></label>
                  <div className="button-row"><button className="btn btn-sm secondary" type="button" disabled={index === 0} onClick={() => moveStep(index, -1)}>↑</button><button className="btn btn-sm secondary" type="button" disabled={index === draft.steps.length - 1} onClick={() => moveStep(index, 1)}>↓</button><button className="btn btn-sm btn-danger" type="button" onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, stepIndex) => stepIndex !== index) })}><Trash2 size={13} /></button></div>
                </div>
              );
            })}
          </div>
          <div className="button-row" style={{ marginTop: 14, justifyContent: "flex-end" }}><button className="btn secondary" type="button" onClick={() => setDraft(null)}>Cancel</button><button className="btn" type="button" disabled={saving || !draft.name.trim() || draft.steps.length === 0} onClick={() => { void saveDraft(); }}>{saving ? "Saving…" : "Save runbook"}</button></div>
        </section>
      )}

      {!loading && !error && runbooks.length === 0 && !draft && <div className="empty-state"><strong>No runbooks yet — compose one from the action catalog.</strong><span>Runbooks execute 1–20 catalog actions in order and stop on the first failure.</span></div>}

      {runbooks.length > 0 && (
        <section className="dash-section table-wrap">
          <TableControls {...controls.controlsProps} searchPlaceholder="Search runbooks, descriptions, actions, status..." />
          <table className="data-table">
            <thead><tr><th className="expander-col" aria-label="Details"></th><th {...controls.sortHeaderProps("name")}>Name</th><th>Description</th><th {...controls.sortHeaderProps("steps")}>Steps</th><th {...controls.sortHeaderProps("lastRun")}>Last run</th><th>Actions</th></tr></thead>
            <tbody>
              {controls.rows.map((runbook) => {
                const expanded = controls.isExpanded(runbook.id);
                const currentRun = activeRun?.runbookId === runbook.id ? activeRun : null;
                return <Fragment key={runbook.id}>
                  <tr className="data-row-clickable" onClick={() => toggleRow(runbook)}>
                    <td>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                    <td><strong>{runbook.name}</strong>{runbook.validationError && <div className="pill red" title={runbook.validationError}>catalog changed</div>}</td>
                    <td className="dim">{runbook.description || "No description"}</td>
                    <td>{runbook.stepCount} <span className={`pill ${runbook.risk === "high" ? "red" : "amber"}`}>{runbook.risk}</span></td>
                    <td>{runbook.lastRun ? <><span className={`pill ${statusClass(runbook.lastRun.status)}`}>{runbook.lastRun.status}</span><div className="dim">{formatTime(runbook.lastRun.startedAt)}</div></> : <span className="dim">Never</span>}</td>
                    <td><div className="button-row" onClick={(event) => event.stopPropagation()}><button className="btn btn-sm" type="button" disabled={Boolean(runbook.validationError)} onClick={() => setRunTarget(runbook)}>Run</button><button className="btn btn-sm secondary" type="button" onClick={() => editRunbook(runbook)}>Edit</button><button className="btn btn-sm btn-danger" type="button" onClick={() => setArchiveTarget(runbook)}>Archive</button></div></td>
                  </tr>
                  {expanded && <tr className="data-row-detail"><td colSpan={6}><div className="data-row-detail-inner">
                    <div className="dash-section-title">steps</div>
                    <ol>{runbook.steps.map((step, index) => <li key={`${runbook.id}-${index}-${step.actionId}`}>{step.actionId}{step.params && <pre className="audit-pre">{JSON.stringify(step.params, null, 2)}</pre>}</li>)}</ol>
                    {currentRun && <div style={{ marginTop: 14 }}><div className="dash-section-title">current run {currentRun.run?.status && <span className={`pill ${statusClass(currentRun.run.status)}`}>{currentRun.run.status}</span>}</div>{currentRun.steps.length === 0 ? <div className="dim">Starting run…</div> : <ol>{currentRun.steps.map((step) => <li key={step.id}><span className={`pill ${statusClass(step.status)}`}>{step.status}</span> {step.action_id}{step.message && <div className="dim">{step.message}</div>}{step.error && <div className="loading-panel error">{step.error}</div>}</li>)}</ol>}</div>}
                    <div style={{ marginTop: 14 }}><div className="dash-section-title">run history</div>{!history[runbook.id] ? <div className="dim">Loading history…</div> : <RunHistoryTable runs={history[runbook.id]} />}</div>
                  </div></td></tr>}
                </Fragment>;
              })}
              {controls.filteredCount === 0 && <tr><td colSpan={6}><div className="empty-state"><strong>No runbooks match this search.</strong><span>Clear the filter to see the full list.</span></div></td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
