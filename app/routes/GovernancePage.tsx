import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { useAuthApi } from "../hooks/useAuthApi";
import { authFetch } from "../lib/authFetch";
import { Shield, RefreshCw, Trash2, Plus } from "lucide-react";

interface PolicyInfo {
  name: string;
  version: string;
  ruleCount: number;
  path: string;
  loadedAt?: number;
}

interface SecretInfo {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
}

interface ApprovalInfo {
  id: string;
  workflowId: string;
  runId: string;
  requestedAt: number;
  requestedBy?: string;
  decidedAt?: number;
  decidedBy?: string;
  decision?: "approve" | "reject";
  reason?: string;
}

interface BudgetInfo {
  id: string;
  scope: string;
  projectId?: string;
  daily_cap_usd?: number;
  monthly_cap_usd?: number;
  warn_pct: number;
  created_at: number;
  updated_at: number;
}

interface BudgetSpending {
  daily: number;
  monthly: number;
}

type Tab = "policies" | "secrets" | "approvals" | "budgets";

export function GovernancePage() {
  const [tab, setTab] = useState<Tab>("policies");
  const [showAddSecret, setShowAddSecret] = useState(false);
  const [showSetBudget, setShowSetBudget] = useState(false);
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretDesc, setNewSecretDesc] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [newDailyCap, setNewDailyCap] = useState("");
  const [newMonthlyCap, setNewMonthlyCap] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [approvalReason, setApprovalReason] = useState<string>("");
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [pendingApprovalRunId, setPendingApprovalRunId] = useState<string | null>(null);
  const [pendingApprovalDecision, setPendingApprovalDecision] = useState<"approve" | "reject" | null>(null);

  const { data: policiesData, refresh: reloadPolicies } = useAuthApi<{ policies: PolicyInfo[]; decisionCount: number }>("/api/governance/policies", 30_000);
  const { data: secretsData, refresh: reloadSecrets } = useAuthApi<{ secrets: SecretInfo[] }>("/api/governance/secrets", 30_000);
  const { data: approvalsData, refresh: reloadApprovals } = useAuthApi<{ pending: ApprovalInfo[]; completed: ApprovalInfo[] }>("/api/governance/approvals", 30_000);
  const { data: budgetsData, refresh: reloadBudgets } = useAuthApi<{ budgets: BudgetInfo[]; spending: BudgetSpending }>("/api/governance/budgets", 30_000);

  async function handleReloadPolicies() {
    await authFetch("/api/governance/policies/reload", { method: "POST" });
    reloadPolicies();
  }

  async function handleAddSecret() {
    if (!newSecretName || !newSecretValue) return;
    const res = await authFetch("/api/governance/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newSecretName, description: newSecretDesc, value: newSecretValue }),
    });
    if (res.ok) {
      setNewSecretName("");
      setNewSecretDesc("");
      setNewSecretValue("");
      setShowAddSecret(false);
      reloadSecrets();
    }
  }

  async function handleDeleteSecret(name: string) {
    if (deleteConfirmId !== name) {
      setDeleteConfirmId(name);
      return;
    }
    const res = await authFetch(`/api/governance/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (res.ok) reloadSecrets();
    setDeleteConfirmId(null);
  }

  async function handleApprovalDecide(runId: string, decision: "approve" | "reject") {
    setPendingApprovalRunId(runId);
    setPendingApprovalDecision(decision);
    setApprovalReason("");
    setShowApprovalModal(true);
  }

  async function handleApprovalSubmit() {
    if (pendingApprovalRunId == null || pendingApprovalDecision == null) return;
    await authFetch(`/api/governance/approvals/${pendingApprovalRunId}/${pendingApprovalDecision}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: approvalReason || undefined }),
    });
    setShowApprovalModal(false);
    setPendingApprovalRunId(null);
    setPendingApprovalDecision(null);
    setApprovalReason("");
    reloadApprovals();
  }

  async function handleSetBudget() {
    await authFetch("/api/governance/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        dailyCapUsd: newDailyCap ? parseFloat(newDailyCap) : null,
        monthlyCapUsd: newMonthlyCap ? parseFloat(newMonthlyCap) : null,
      }),
    });
    setShowSetBudget(false);
    setNewDailyCap("");
    setNewMonthlyCap("");
    reloadBudgets();
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: "policies", label: "Policies" },
    { id: "secrets", label: "Secrets" },
    { id: "approvals", label: "Approvals" },
    { id: "budgets", label: "Budgets" },
  ];

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">
          <Shield size={20} />
          <h1>Governance</h1>
        </div>
      </div>

      <div className="tab-bar gov-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`gov-tab-btn ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "policies" ? (
        <div className="section-card">
          <div className="section-card-header">
            <h2>Policy Documents</h2>
            <button className="btn-ghost" onClick={handleReloadPolicies}>
              <RefreshCw size={14} /> Reload
            </button>
          </div>
          {!policiesData ? (
            <div className="loading-dim">loading…</div>
          ) : policiesData.policies.length === 0 ? (
            <p className="text-muted">No policies loaded.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>Name</th><th>Version</th><th>Rules</th><th>Path</th></tr>
              </thead>
              <tbody>
                {policiesData.policies.map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td>{p.version}</td>
                    <td>{p.ruleCount}</td>
                    <td className="text-muted text-xs">{p.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {tab === "secrets" ? (
        <div className="section-card">
          <div className="section-card-header">
            <h2>Secrets Vault</h2>
            <button className="btn-ghost" onClick={() => setShowAddSecret(true)}>
              <Plus size={14} /> Add Secret
            </button>
          </div>
          {showAddSecret ? (
            <div className="modal-overlay" onClick={() => setShowAddSecret(false)}>
              <div className="modal-box" onClick={(e) => e.stopPropagation()}>
                <div className="modal-title">Add Secret</div>
                <div className="modal-input-row">
                  <label className="modal-input-label">Name<input className="modal-input" value={newSecretName} onChange={(e) => setNewSecretName(e.target.value)} placeholder="MY_SECRET" /></label>
                  <label className="modal-input-label">Description<input className="modal-input" value={newSecretDesc} onChange={(e) => setNewSecretDesc(e.target.value)} placeholder="Optional description" /></label>
                  <label className="modal-input-label">Value<input className="modal-input" type="password" value={newSecretValue} onChange={(e) => setNewSecretValue(e.target.value)} placeholder="secret value (masked)" /></label>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
                  <button className="btn-ghost" onClick={() => setShowAddSecret(false)}>Cancel</button>
                  <button className="btn-primary" onClick={handleAddSecret}>Save</button>
                </div>
              </div>
            </div>
          ) : null}
          {showApprovalModal ? (
            <div className="modal-overlay" onClick={() => setShowApprovalModal(false)}>
              <div className="modal-box" onClick={(e) => e.stopPropagation()}>
                <div className="modal-title">Approval Reason</div>
                <div className="modal-input-row">
                  <label className="modal-input-label">Reason (optional)<input className="modal-input" value={approvalReason} onChange={(e) => setApprovalReason(e.target.value)} placeholder={`Reason for ${pendingApprovalDecision ?? "decision"}`} /></label>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
                  <button className="btn-ghost" onClick={() => setShowApprovalModal(false)}>Cancel</button>
                  <button className="btn-primary" onClick={handleApprovalSubmit}>Submit Decision</button>
                </div>
              </div>
            </div>
          ) : null}
          {!secretsData ? (
            <div className="loading-dim">loading…</div>
          ) : secretsData.secrets.length === 0 ? (
            <p className="text-muted">No secrets stored.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>Name</th><th>Description</th><th>Created</th><th>Updated</th><th></th></tr>
              </thead>
              <tbody>
                {secretsData.secrets.map((s) => (
                  <tr key={s.id}>
                    <td className="font-mono text-sm">{s.name}</td>
                    <td className="text-muted text-sm">{s.description || "—"}</td>
                    <td className="text-muted text-xs">{new Date(s.created_at).toLocaleDateString()}</td>
                    <td className="text-muted text-xs">{new Date(s.updated_at).toLocaleDateString()}</td>
                    <td>
                      {deleteConfirmId === s.name ? (
                        <span>
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Delete?</span>
                          <button className="btn-ghost btn-sm" style={{ color: "var(--red)", marginLeft: 4 }} onClick={() => { setDeleteConfirmId(null); handleDeleteSecret(s.name); }}>Yes</button>
                          <button className="btn-ghost btn-sm" style={{ marginLeft: 4 }} onClick={() => setDeleteConfirmId(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button className="btn-ghost btn-danger" onClick={() => handleDeleteSecret(s.name)}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {tab === "approvals" ? (
        <div className="section-card">
          <div className="section-card-header">
            <h2>Approval Gates</h2>
          </div>
          {!approvalsData ? (
            <div className="loading-dim">loading…</div>
          ) : (
            <>
              {approvalsData.pending.length === 0 ? <p className="text-muted">No pending approvals.</p> : null}
              {approvalsData.pending.map((a) => (
                <div key={a.id} className="approval-item">
                  <div className="approval-info">
                    <div className="font-medium">Workflow: {a.workflowId}</div>
                    <div className="text-muted text-sm">Run: {a.runId}</div>
                    <div className="text-muted text-xs">Requested {fmtAge(a.requestedAt)} by {a.requestedBy ?? "unknown"}</div>
                  </div>
                  <div className="approval-actions">
                    <button className="btn-primary btn-sm" onClick={() => handleApprovalDecide(a.runId, "approve")}>Approve</button>
                    <button className="btn-ghost btn-sm" onClick={() => handleApprovalDecide(a.runId, "reject")}>Reject</button>
                  </div>
                </div>
              ))}
              {approvalsData.completed.length > 0 ? (
                <>
                  <h3 className="text-muted mt-6 mb-2">Completed</h3>
                  {approvalsData.completed.map((a) => (
                    <div key={a.id} className="approval-item completed">
                      <div className="approval-info">
                        <div className="font-medium">Workflow: {a.workflowId}</div>
                        <div className="text-muted text-xs">
                          {a.decision?.toUpperCase()} by {a.decidedBy} {a.decidedAt ? fmtAge(a.decidedAt) : ""}
                          {a.reason ? ` — ${a.reason}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {tab === "budgets" ? (
        <div className="section-card">
          <div className="section-card-header">
            <h2>Budget Caps</h2>
            <button className="btn-ghost" onClick={() => setShowSetBudget(true)}>
              <Plus size={14} /> Set Budget
            </button>
          </div>
          {showSetBudget ? (
            <div className="modal-overlay" onClick={() => setShowSetBudget(false)}>
              <div className="modal-box" onClick={(e) => e.stopPropagation()}>
                <div className="modal-title">Set Global Budget</div>
                <div className="modal-input-row">
                  <label className="modal-input-label">Daily Cap (USD)<input className="modal-input" type="number" value={newDailyCap} onChange={(e) => setNewDailyCap(e.target.value)} placeholder="e.g. 50.00" /></label>
                  <label className="modal-input-label">Monthly Cap (USD)<input className="modal-input" type="number" value={newMonthlyCap} onChange={(e) => setNewMonthlyCap(e.target.value)} placeholder="e.g. 500.00" /></label>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
                  <button className="btn-ghost" onClick={() => setShowSetBudget(false)}>Cancel</button>
                  <button className="btn-primary" onClick={handleSetBudget}>Save</button>
                </div>
              </div>
            </div>
          ) : null}
          {!budgetsData ? (
            <div className="loading-dim">loading…</div>
          ) : (
            <>
              <div className="budget-summary-cards">
                <div className="budget-card">
                  <div className="budget-card-label">Daily Spend</div>
                  <div className="budget-card-value">${budgetsData.spending.daily.toFixed(4)}</div>
                  {budgetsData.budgets[0]?.daily_cap_usd != null ? (
                    <div className="budget-bar">
                      <div className="budget-bar-fill" style={{ width: `${Math.min(100, (budgetsData.spending.daily / budgetsData.budgets[0].daily_cap_usd) * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
                <div className="budget-card">
                  <div className="budget-card-label">Monthly Spend</div>
                  <div className="budget-card-value">${budgetsData.spending.monthly.toFixed(4)}</div>
                  {budgetsData.budgets[0]?.monthly_cap_usd != null ? (
                    <div className="budget-bar">
                      <div className="budget-bar-fill" style={{ width: `${Math.min(100, (budgetsData.spending.monthly / budgetsData.budgets[0].monthly_cap_usd) * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
              </div>
              {budgetsData.budgets.length === 0 ? (
                <p className="text-muted mt-4">No budget configured. Click "Set Budget" to add one.</p>
              ) : (
                <table className="data-table mt-4">
                  <thead>
                    <tr><th>Scope</th><th>Daily Cap</th><th>Monthly Cap</th><th>Warn %</th></tr>
                  </thead>
                  <tbody>
                    {budgetsData.budgets.map((b) => (
                      <tr key={b.id}>
                        <td>{b.scope}</td>
                        <td>{b.daily_cap_usd != null ? `$${b.daily_cap_usd}` : "—"}</td>
                        <td>{b.monthly_cap_usd != null ? `$${b.monthly_cap_usd}` : "—"}</td>
                        <td>{(b.warn_pct * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function fmtAge(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}