import { useState } from "react";
import { useAuthApi } from "../hooks/useAuthApi";
import { useAction } from "../hooks/useAction";
import { authFetch } from "../lib/authFetch";
import { Building2, KeyRound, RefreshCw, Shield, Trash2, Plus, UserRound } from "lucide-react";
import { TableControls } from "../components/TableControls";
import { useTableControls } from "../hooks/useTableControls";

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

type RbacRole = "owner" | "operator" | "auditor" | "viewer";

interface GovernanceUser {
  id: string;
  displayName: string | null;
  email: string | null;
  role: RbacRole;
  tenantId: string;
  lastSeen: number | null;
  createdAt: number | null;
}

interface GovernanceUsersData {
  users: GovernanceUser[];
  currentRole: RbacRole;
}

interface RbacMatrixData {
  roles: RbacRole[];
  matrix: Record<RbacRole, string[]>;
}

interface TenantInfo {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  projectCount?: number;
}

type Tab = "users" | "policies" | "secrets" | "approvals" | "budgets";
type ApprovalRow = ApprovalInfo & { status: "pending" | "completed" };

const ROLE_OPTIONS: RbacRole[] = ["viewer", "auditor", "operator", "owner"];

export function GovernancePage() {
  const [tab, setTab] = useState<Tab>("users");
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

  const { data: policiesData, loading: policiesLoading, error: policiesError, refresh: reloadPolicies } = useAuthApi<{ policies: PolicyInfo[]; decisionCount: number }>("/api/governance/policies", 30_000);
  const { data: secretsData, loading: secretsLoading, error: secretsError, refresh: reloadSecrets } = useAuthApi<{ secrets: SecretInfo[] }>("/api/governance/secrets", 30_000);
  const { data: approvalsData, loading: approvalsLoading, error: approvalsError, refresh: reloadApprovals } = useAuthApi<{ pending: ApprovalInfo[]; completed: ApprovalInfo[] }>("/api/governance/approvals", 30_000);
  const { data: budgetsData, loading: budgetsLoading, error: budgetsError, refresh: reloadBudgets } = useAuthApi<{ budgets: BudgetInfo[]; spending: BudgetSpending }>("/api/governance/budgets", 30_000);
  const { data: usersData, loading: usersLoading, error: usersError, refresh: reloadUsers } = useAuthApi<GovernanceUsersData>("/api/governance/users", 30_000);
  const { data: matrixData, loading: matrixLoading, error: matrixError, refresh: reloadMatrix } = useAuthApi<RbacMatrixData>("/api/rbac/matrix", 60_000);
  const { data: tenantsData, loading: tenantsLoading, error: tenantsError, refresh: reloadTenants } = useAuthApi<{ tenants: TenantInfo[] }>("/api/tenants", 60_000);

  const policiesCtrl = useTableControls<PolicyInfo, "name" | "version" | "ruleCount">({
    rows: policiesData?.policies ?? [],
    pageSize: 25,
    filterText: (row) => [row.name, row.version, row.path].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "name": return row.name;
        case "version": return row.version;
        case "ruleCount": return row.ruleCount;
        default: return "";
      }
    },
    defaultSort: { key: "name", dir: "asc" },
  });

  const secretsCtrl = useTableControls<SecretInfo, "name" | "created_at" | "updated_at">({
    rows: secretsData?.secrets ?? [],
    pageSize: 25,
    filterText: (row) => [row.name, row.description].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "created_at": return row.created_at;
        case "updated_at": return row.updated_at;
        default: return row.name;
      }
    },
    defaultSort: { key: "name", dir: "asc" },
  });

  const budgetsCtrl = useTableControls<BudgetInfo, "scope" | "daily_cap_usd" | "monthly_cap_usd">({
    rows: budgetsData?.budgets ?? [],
    pageSize: 25,
    filterText: (row) => [row.scope, row.projectId ?? ""].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "daily_cap_usd": return row.daily_cap_usd ?? 0;
        case "monthly_cap_usd": return row.monthly_cap_usd ?? 0;
        default: return row.scope;
      }
    },
    defaultSort: { key: "scope", dir: "asc" },
  });

  const approvalRows: ApprovalRow[] = [
    ...(approvalsData?.pending ?? []).map((row) => ({ ...row, status: "pending" as const })),
    ...(approvalsData?.completed ?? []).map((row) => ({ ...row, status: "completed" as const })),
  ];
  const approvalsCtrl = useTableControls<ApprovalRow, "workflowId" | "status" | "requestedAt" | "decidedAt">({
    rows: approvalRows,
    pageSize: 25,
    filterText: (row) => [row.workflowId, row.runId, row.requestedBy ?? "", row.decidedBy ?? "", row.reason ?? "", row.status].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "status": return row.status;
        case "requestedAt": return row.requestedAt;
        case "decidedAt": return row.decidedAt ?? 0;
        default: return row.workflowId;
      }
    },
    defaultSort: { key: "requestedAt", dir: "desc" },
  });

  const usersCtrl = useTableControls<GovernanceUser, "displayName" | "role" | "tenantId">({
    rows: usersData?.users ?? [],
    pageSize: 25,
    filterText: (row) => [row.displayName ?? "", row.email ?? "", row.id, row.role, row.tenantId].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "role": return row.role;
        case "tenantId": return row.tenantId;
        default: return row.displayName ?? row.email ?? row.id;
      }
    },
    defaultSort: { key: "displayName", dir: "asc" },
  });

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
    { id: "users", label: "Users & Roles" },
    { id: "policies", label: "Policies" },
    { id: "secrets", label: "Secrets" },
    { id: "approvals", label: "Approvals" },
    { id: "budgets", label: "Budgets" },
  ];
  const latestBudgetChange = Math.max(0, ...(budgetsData?.budgets ?? []).map((budget) => budget.updated_at));
  const latestSecretChange = Math.max(0, ...(secretsData?.secrets ?? []).map((secret) => secret.updated_at));

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">
          <Shield size={20} />
          <h1>Access &amp; Policy</h1>
        </div>
      </div>

      <div className="tab-bar gov-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`gov-tab-btn ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="governance-summary-grid">
        <div className="governance-summary-card">
          <span>Users</span>
          <strong>{usersData?.users.length ?? "—"}</strong>
          <small>{usersData ? `current role ${usersData.currentRole}` : "loading access"}</small>
        </div>
        <div className="governance-summary-card">
          <span>Policies</span>
          <strong>{policiesData?.policies.length ?? "—"}</strong>
          <small>{policiesData ? `${policiesData.decisionCount} stored decisions` : "loading policy state"}</small>
        </div>
        <div className="governance-summary-card">
          <span>Approvals</span>
          <strong>{approvalsData?.pending.length ?? "—"}</strong>
          <small>{approvalsData ? `${approvalsData.completed.length} completed` : "loading approvals"}</small>
        </div>
        <div className="governance-summary-card">
          <span>Secrets</span>
          <strong>{secretsData?.secrets.length ?? "—"}</strong>
          <small>{latestSecretChange > 0 ? `changed ${fmtAge(latestSecretChange)}` : "no changes recorded"}</small>
        </div>
        <div className="governance-summary-card">
          <span>Budgets</span>
          <strong>{budgetsData?.budgets.length ?? "—"}</strong>
          <small>{latestBudgetChange > 0 ? `changed ${fmtAge(latestBudgetChange)}` : "no cap configured"}</small>
        </div>
      </div>

      {tab === "users" ? (
        <div className="governance-access-grid">
          <section className="section-card governance-access-main">
            <div className="section-card-header">
              <h2>User Directory</h2>
              <button className="btn btn-ghost" onClick={() => { reloadUsers(); reloadMatrix(); reloadTenants(); }}>
                <RefreshCw size={14} /> Refresh
              </button>
            </div>
            {usersData ? (
              <div className="access-context-row">
                <span className={`role-badge role-${usersData.currentRole}`}>Your role: {usersData.currentRole}</span>
                <span className="text-muted text-sm">
                  {usersData.currentRole === "owner" ? "Owners can change role bindings." : "Role changes are only shown to owners."}
                </span>
              </div>
            ) : null}
            {usersError && !usersData ? (
              <div className="loading-dim error">Users did not load: {usersError} <button className="btn btn-ghost btn-sm" onClick={reloadUsers}>Retry</button></div>
            ) : usersLoading && !usersData ? (
              <div className="loading-dim">loading...</div>
            ) : !usersData || usersData.users.length === 0 ? (
              <div className="empty-state compact">
                <UserRound size={16} />
                <div>
                  <strong>No users found.</strong>
                  <div>Local or SSO users appear here after they sign in or are created by an enabled identity flow.</div>
                </div>
              </div>
            ) : (
              <>
                <TableControls {...usersCtrl.controlsProps} searchPlaceholder="Filter users..." />
                <div className="table-container">
                  <table className="data-table governance-table governance-users-table">
                    <thead>
                      <tr>
                        <th {...usersCtrl.sortHeaderProps("displayName")}>User <span className="sortable-th-arrow">{usersCtrl.sort.key === "displayName" ? (usersCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...usersCtrl.sortHeaderProps("role")}>Role <span className="sortable-th-arrow">{usersCtrl.sort.key === "role" ? (usersCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...usersCtrl.sortHeaderProps("tenantId")}>Tenant <span className="sortable-th-arrow">{usersCtrl.sort.key === "tenantId" ? (usersCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th>Last seen</th>
                        {usersData.currentRole === "owner" ? <th>Role editor</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {usersCtrl.rows.map((user) => (
                        <GovernanceUserRow
                          key={`${user.tenantId}:${user.id}`}
                          user={user}
                          canEdit={usersData.currentRole === "owner"}
                          onChanged={reloadUsers}
                        />
                      ))}
                      {usersCtrl.filteredCount === 0 && (
                        <tr>
                          <td colSpan={usersData.currentRole === "owner" ? 5 : 4} className="loading-dim">No users match the current filter.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <aside className="governance-access-side">
            <section className="section-card">
              <div className="section-card-header">
                <h2><KeyRound size={15} /> Permission Matrix</h2>
              </div>
              {matrixError && !matrixData ? (
                <div className="loading-dim error">Matrix did not load: {matrixError} <button className="btn btn-ghost btn-sm" onClick={reloadMatrix}>Retry</button></div>
              ) : matrixLoading && !matrixData ? (
                <div className="loading-dim">loading...</div>
              ) : !matrixData ? (
                <p className="text-muted">No RBAC matrix returned.</p>
              ) : (
                <div className="permission-matrix-list">
                  {matrixData.roles.map((role) => (
                    <div className="permission-role-row" key={role}>
                      <span className={`role-badge role-${role}`}>{role}</span>
                      <span className="permission-actions">{matrixData.matrix[role].join(", ")}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="section-card">
              <div className="section-card-header">
                <h2><Building2 size={15} /> Tenants</h2>
              </div>
              {tenantsError && !tenantsData ? (
                <div className="loading-dim error">Tenants did not load: {tenantsError} <button className="btn btn-ghost btn-sm" onClick={reloadTenants}>Retry</button></div>
              ) : tenantsLoading && !tenantsData ? (
                <div className="loading-dim">loading...</div>
              ) : !tenantsData || tenantsData.tenants.length === 0 ? (
                <p className="text-muted">No tenants are configured.</p>
              ) : (
                <>
                  {tenantsData.tenants.length === 1 ? (
                    <p className="text-muted tenant-single-copy">Single-tenant deployment - one tenant configured.</p>
                  ) : null}
                  <div className="tenant-list">
                    {tenantsData.tenants.map((tenant) => (
                      <div className="tenant-row" key={tenant.id}>
                        <div>
                          <div className="font-medium">{tenant.name}</div>
                          <div className="text-muted text-xs">{tenant.id} · created {formatDate(tenant.createdAt)}</div>
                        </div>
                        <div className="tenant-row-meta">
                          <span className="badge-gray">{tenant.status}</span>
                          {tenant.projectCount != null ? <span className="text-muted text-xs">{tenant.projectCount} projects</span> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className="section-card access-disabled-panel">
              <div className="access-disabled-item">
                <strong>Email invitations</strong>
                <span>Not enabled in this deployment. SMTP-backed invitations are out of scope for this pass.</span>
              </div>
              <div className="access-disabled-item">
                <strong>View As impersonation</strong>
                <span>Not enabled in this deployment. Impersonation is deferred for a separate audited design.</span>
              </div>
            </section>
          </aside>
        </div>
      ) : null}

      {tab === "policies" ? (
        <div className="section-card">
          <div className="section-card-header">
            <h2>Policy Documents</h2>
            <button className="btn btn-ghost" onClick={handleReloadPolicies}>
              <RefreshCw size={14} /> Reload
            </button>
          </div>
          {policiesError && !policiesData ? (
            <div className="loading-dim error">Policies did not load: {policiesError} <button className="btn btn-ghost btn-sm" onClick={reloadPolicies}>Retry</button></div>
          ) : policiesLoading && !policiesData ? (
            <div className="loading-dim">loading…</div>
          ) : !policiesData || policiesData.policies.length === 0 ? (
            <p className="text-muted">No policies loaded. Reload when local YAML/JSON policy documents are available.</p>
          ) : (
            <>
              <TableControls {...policiesCtrl.controlsProps} searchPlaceholder="Filter policies..." />
              <div className="table-container">
                <table className="data-table governance-table">
                <thead>
                  <tr>
                    <th {...policiesCtrl.sortHeaderProps("name")}>Name <span className="sortable-th-arrow">{policiesCtrl.sort.key === "name" ? (policiesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th {...policiesCtrl.sortHeaderProps("version")}>Version <span className="sortable-th-arrow">{policiesCtrl.sort.key === "version" ? (policiesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th {...policiesCtrl.sortHeaderProps("ruleCount")}>Rules <span className="sortable-th-arrow">{policiesCtrl.sort.key === "ruleCount" ? (policiesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th>Path</th>
                  </tr>
                </thead>
                <tbody>
                  {policiesCtrl.rows.map((p) => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td>{p.version}</td>
                      <td>{p.ruleCount}</td>
                      <td className="text-muted text-xs">{p.path}</td>
                    </tr>
                  ))}
                  {policiesCtrl.filteredCount === 0 && (
                    <tr>
                      <td colSpan={4} className="loading-dim">No policies match the current filter.</td>
                    </tr>
                  )}
                </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}

      {tab === "secrets" ? (
        <div className="section-card">
          <div className="section-card-header">
            <h2>Secrets Vault</h2>
            <button className="btn btn-ghost" onClick={() => setShowAddSecret(true)}>
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
                  <button className="btn btn-ghost" onClick={() => setShowAddSecret(false)}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleAddSecret}>Save</button>
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
                  <button className="btn btn-ghost" onClick={() => setShowApprovalModal(false)}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleApprovalSubmit}>Submit Decision</button>
                </div>
              </div>
            </div>
          ) : null}
          {secretsError && !secretsData ? (
            <div className="loading-dim error">Secrets did not load: {secretsError} <button className="btn btn-ghost btn-sm" onClick={reloadSecrets}>Retry</button></div>
          ) : secretsLoading && !secretsData ? (
            <div className="loading-dim">loading…</div>
          ) : !secretsData || secretsData.secrets.length === 0 ? (
            <p className="text-muted">No secrets stored. Add a managed secret when an integration needs vaulted credentials.</p>
          ) : (
            <>
              <TableControls {...secretsCtrl.controlsProps} searchPlaceholder="Filter secrets..." />
              <div className="table-container">
                <table className="data-table governance-table">
                <thead>
                  <tr>
                    <th {...secretsCtrl.sortHeaderProps("name")}>Name <span className="sortable-th-arrow">{secretsCtrl.sort.key === "name" ? (secretsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th>Description</th>
                    <th {...secretsCtrl.sortHeaderProps("created_at")}>Created <span className="sortable-th-arrow">{secretsCtrl.sort.key === "created_at" ? (secretsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th {...secretsCtrl.sortHeaderProps("updated_at")}>Updated <span className="sortable-th-arrow">{secretsCtrl.sort.key === "updated_at" ? (secretsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {secretsCtrl.rows.map((s) => (
                    <tr key={s.id}>
                      <td className="font-mono text-sm">{s.name}</td>
                      <td className="text-muted text-sm">{s.description || "—"}</td>
                      <td className="text-muted text-xs">{new Date(s.created_at).toLocaleDateString()}</td>
                      <td className="text-muted text-xs">{new Date(s.updated_at).toLocaleDateString()}</td>
                      <td>
                        {deleteConfirmId === s.name ? (
                          <span>
                            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Delete?</span>
                            <button className="btn btn-ghost btn-sm" style={{ color: "var(--red)", marginLeft: 4 }} onClick={() => { setDeleteConfirmId(null); handleDeleteSecret(s.name); }}>Yes</button>
                            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 4 }} onClick={() => setDeleteConfirmId(null)}>Cancel</button>
                          </span>
                        ) : (
                          <button className="btn btn-ghost btn-danger" onClick={() => handleDeleteSecret(s.name)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {secretsCtrl.filteredCount === 0 && (
                    <tr>
                      <td colSpan={5} className="loading-dim">No secrets match the current filter.</td>
                    </tr>
                  )}
                </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}

      {tab === "approvals" ? (
        <div className="section-card">
          <div className="section-card-header">
            <h2>Approval Gates</h2>
          </div>
          {approvalsError && !approvalsData ? (
            <div className="loading-dim error">Approvals did not load: {approvalsError} <button className="btn btn-ghost btn-sm" onClick={reloadApprovals}>Retry</button></div>
          ) : approvalsLoading && !approvalsData ? (
            <div className="loading-dim">loading…</div>
          ) : !approvalsData ? (
            <p className="text-muted">No approval data returned yet. Pending approval gates appear here when a workflow or high-risk action needs review.</p>
          ) : (
            approvalRows.length === 0 ? (
              <p className="text-muted">No approval data returned yet. Pending approval gates appear here when a workflow or high-risk action needs review.</p>
            ) : (
              <>
                <TableControls {...approvalsCtrl.controlsProps} searchPlaceholder="Filter approvals..." />
                <div className="table-container">
                  <table className="data-table governance-table governance-approvals-table">
                    <thead>
                      <tr>
                        <th {...approvalsCtrl.sortHeaderProps("workflowId")}>Workflow <span className="sortable-th-arrow">{approvalsCtrl.sort.key === "workflowId" ? (approvalsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th>Run</th>
                        <th {...approvalsCtrl.sortHeaderProps("status")}>Status <span className="sortable-th-arrow">{approvalsCtrl.sort.key === "status" ? (approvalsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...approvalsCtrl.sortHeaderProps("requestedAt")}>Requested <span className="sortable-th-arrow">{approvalsCtrl.sort.key === "requestedAt" ? (approvalsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...approvalsCtrl.sortHeaderProps("decidedAt")}>Decision <span className="sortable-th-arrow">{approvalsCtrl.sort.key === "decidedAt" ? (approvalsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {approvalsCtrl.rows.map((a) => (
                        <tr key={a.id}>
                          <td className="font-medium">{a.workflowId}</td>
                          <td className="font-mono text-xs">{a.runId}</td>
                          <td><span className={`pill ${a.status === "pending" ? "amber" : a.decision === "approve" ? "green" : "gray"}`}>{a.status === "pending" ? "pending" : a.decision ?? "completed"}</span></td>
                          <td className="text-muted text-xs">{fmtAge(a.requestedAt)} by {a.requestedBy ?? "unknown"}</td>
                          <td className="text-muted text-xs">{a.decidedAt ? `${a.decision?.toUpperCase() ?? "DECIDED"} by ${a.decidedBy ?? "unknown"} ${fmtAge(a.decidedAt)}` : "—"}{a.reason ? ` · ${a.reason}` : ""}</td>
                          <td>
                            {a.status === "pending" ? (
                              <div className="approval-actions">
                                <button className="btn btn-primary btn-sm" onClick={() => handleApprovalDecide(a.runId, "approve")}>Approve</button>
                                <button className="btn btn-ghost btn-sm" onClick={() => handleApprovalDecide(a.runId, "reject")}>Reject</button>
                              </div>
                            ) : (
                              <span className="text-muted text-xs">closed</span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {approvalsCtrl.filteredCount === 0 && (
                        <tr>
                          <td colSpan={6} className="loading-dim">No approvals match the current filter.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )
          )}
        </div>
      ) : null}

      {tab === "budgets" ? (
        <div className="section-card">
          <div className="section-card-header">
            <h2>Budget Caps</h2>
            <button className="btn btn-ghost" onClick={() => setShowSetBudget(true)}>
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
                  <button className="btn btn-ghost" onClick={() => setShowSetBudget(false)}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleSetBudget}>Save</button>
                </div>
              </div>
            </div>
          ) : null}
          {budgetsError && !budgetsData ? (
            <div className="loading-dim error">Budgets did not load: {budgetsError} <button className="btn btn-ghost btn-sm" onClick={reloadBudgets}>Retry</button></div>
          ) : budgetsLoading && !budgetsData ? (
            <div className="loading-dim">loading…</div>
          ) : !budgetsData ? (
            <p className="text-muted">No budget data returned yet. Set a global cap once gateway spend should be governed.</p>
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
                <>
                  <TableControls {...budgetsCtrl.controlsProps} searchPlaceholder="Filter budgets..." />
                  <div className="table-container mt-4">
                    <table className="data-table governance-table">
                    <thead>
                      <tr>
                        <th {...budgetsCtrl.sortHeaderProps("scope")}>Scope <span className="sortable-th-arrow">{budgetsCtrl.sort.key === "scope" ? (budgetsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...budgetsCtrl.sortHeaderProps("daily_cap_usd")}>Daily Cap <span className="sortable-th-arrow">{budgetsCtrl.sort.key === "daily_cap_usd" ? (budgetsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...budgetsCtrl.sortHeaderProps("monthly_cap_usd")}>Monthly Cap <span className="sortable-th-arrow">{budgetsCtrl.sort.key === "monthly_cap_usd" ? (budgetsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th>Warn %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {budgetsCtrl.rows.map((b) => (
                        <tr key={b.id}>
                          <td>{b.scope}</td>
                          <td>{b.daily_cap_usd != null ? `$${b.daily_cap_usd}` : "—"}</td>
                          <td>{b.monthly_cap_usd != null ? `$${b.monthly_cap_usd}` : "—"}</td>
                          <td>{(b.warn_pct * 100).toFixed(0)}%</td>
                        </tr>
                      ))}
                      {budgetsCtrl.filteredCount === 0 && (
                        <tr>
                          <td colSpan={4} className="loading-dim">No budgets match the current filter.</td>
                        </tr>
                      )}
                    </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GovernanceUserRow({ user, canEdit, onChanged }: { user: GovernanceUser; canEdit: boolean; onChanged: () => void }) {
  const roleAction = useAction(`/api/governance/users/${encodeURIComponent(user.id)}/role`);
  const [selectedRole, setSelectedRole] = useState<RbacRole>(user.role);

  async function handleRoleChange(nextRole: RbacRole) {
    setSelectedRole(nextRole);
    if (nextRole === user.role) return;
    const label = user.email ?? user.displayName ?? user.id;
    const confirmed = window.confirm(`Change ${label} from ${user.role} to ${nextRole}?`);
    if (!confirmed) {
      setSelectedRole(user.role);
      return;
    }
    const ok = await roleAction.run({ role: nextRole, tenantId: user.tenantId });
    if (ok) onChanged();
    else setSelectedRole(user.role);
  }

  return (
    <tr>
      <td>
        <div className="font-medium">{user.displayName ?? user.id}</div>
        <div className="text-muted text-xs">{user.email ?? user.id}</div>
      </td>
      <td><span className={`role-badge role-${user.role}`}>{user.role}</span></td>
      <td className="font-mono text-xs">{user.tenantId}</td>
      <td className="text-muted text-xs">{user.lastSeen ? formatDate(user.lastSeen) : "Not recorded"}</td>
      {canEdit ? (
        <td>
          <select
            className="governance-role-select"
            value={selectedRole}
            disabled={roleAction.loading}
            aria-label={`Role for ${user.email ?? user.id}`}
            onChange={(event) => handleRoleChange(event.target.value as RbacRole)}
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
          {roleAction.error ? <div className="role-action-error">{roleAction.error}</div> : null}
        </td>
      ) : null}
    </tr>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
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
