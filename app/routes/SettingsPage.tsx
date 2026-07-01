import { useState, useEffect } from "react";
import { authFetch } from "../lib/authFetch";
import { useTenantContext } from "../hooks/useTenantContext";

interface AuthStatus {
  tokenSet: boolean;
  productionMode: boolean;
  dashboardDbEnabled: boolean;
  cloudflareHeadersPresent: boolean;
  note: string;
}

interface LicenseStatus {
  tier: string;
  features: string[];
  tenantId: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  licensed: boolean;
}

interface TelemetryConsent {
  consented: boolean;
  updatedAt: string;
}

interface TelemetryPayload {
  events: unknown[];
  runCount: number;
  passSuccessRate: number;
  passFailRate: number;
  modelUsageHistogram: Record<string, number>;
  shippedAt: string;
}

interface SystemConfig {
  config: {
    financeAgent?: {
      enabled: boolean;
      modelOverride?: string;
      processingTimeout?: number;
    };
    pipelineStages?: {
      research?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      write?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      publishPrep?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      verify?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      scout?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      rank?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
    };
    alertThresholds?: {
      pipelineFailureRate: number;
      modelResponseTimeMs: number;
      gpuUtilization: number;
    };
    autoPublish?: {
      enabled: boolean;
      verticals: string[];
      approvalRequired: string[];
    };
    approvalWorkflows?: {
      enabled: boolean;
      requiredVerticals: string[];
      maxArticlesPerDay: number;
    };
  };
}

interface SystemConfigHistory {
  id: string;
  timestamp: string;
  changedBy: string;
  changes: string[];
  configSnapshot: Record<string, any>;
}

type AccessRole = "owner" | "operator" | "auditor" | "viewer";

interface AccessUser {
  id: string;
  email: string;
  name: string | null;
  authMethod: string;
  createdAt: number;
  tenantId: string;
  role: AccessRole;
}

interface AccessState {
  users: AccessUser[];
  currentRole: AccessRole;
}

interface NotificationRule {
  id: number;
  kind: string;
  enabled: boolean;
  threshold: unknown;
  channels: unknown;
  updatedAt: number;
}

type ThemePref = "dark" | "light";
type VariantPref = "terminal" | "compact";

function WCard({ children, className = "", style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`w-card ${className}`} style={style}>{children}</div>;
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: "green" | "red" | "amber" | "gray" | "blue" }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

type TabId = "preferences" | "auth" | "access" | "license" | "telemetry" | "finance" | "pipeline" | "alerts" | "approval" | "history";

const TABS: { id: TabId; label: string }[] = [
  { id: "preferences", label: "Preferences" },
  { id: "auth", label: "Auth & Stack" },
  { id: "access", label: "Access" },
  { id: "license", label: "License" },
  { id: "telemetry", label: "Telemetry" },
  { id: "finance", label: "Finance Agent" },
  { id: "pipeline", label: "Pipeline Stages" },
  { id: "alerts", label: "Alert Thresholds" },
  { id: "approval", label: "Auto-publish/Approval" },
  { id: "history", label: "Config History" },
];

const DEFAULT_POLL_OPTIONS = [10_000, 30_000, 60_000, 120_000];
const DEFAULT_POLL_KEY = "tib-default-poll-ms";

async function readJson<T>(path: string): Promise<T> {
  const response = await authFetch(path);
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  if (json && typeof json === "object" && "data" in json) {
    return json.data as T;
  }
  return json as T;
}

function storedTheme(): ThemePref {
  return localStorage.getItem("tib-theme") === "light" ? "light" : "dark";
}

function storedVariant(): VariantPref {
  return localStorage.getItem("tib-variant") === "compact" ? "compact" : "terminal";
}

function storedPollInterval(): number {
  const parsed = Number(localStorage.getItem(DEFAULT_POLL_KEY));
  return DEFAULT_POLL_OPTIONS.includes(parsed) ? parsed : 30_000;
}

export function SettingsPage() {
  const { tenantId, projectId, setTenantId, setProjectId } = useTenantContext();
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [telemetryPayload, setTelemetryPayload] = useState<TelemetryPayload | null>(null);
  const [telemetryConsent, setTelemetryConsent] = useState<TelemetryConsent | null>(null);
  const [systemConfig, setSystemConfig] = useState<SystemConfig | null>(null);
  const [configHistory, setConfigHistory] = useState<SystemConfigHistory[]>([]);
  const [accessState, setAccessState] = useState<AccessState | null>(null);
  const [notificationRules, setNotificationRules] = useState<NotificationRule[]>([]);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [accessMessage, setAccessMessage] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", password: "", role: "viewer" as AccessRole });
  const [activeTab, setActiveTab] = useState<TabId>("preferences");
  const [themePref, setThemePref] = useState<ThemePref>(storedTheme);
  const [variantPref, setVariantPref] = useState<VariantPref>(storedVariant);
  const [pollIntervalMs, setPollIntervalMs] = useState<number>(storedPollInterval);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      setLoading(true);
      setError(null);
      const results = await Promise.allSettled([
        readJson<AuthStatus>("/api/settings/auth-status"),
        readJson<LicenseStatus>("/api/licensing/status"),
        readJson<TelemetryPayload>("/api/telemetry/preview"),
        readJson<SystemConfig>("/api/system-config"),
        readJson<{ history: SystemConfigHistory[] }>("/api/system-config/history"),
        readJson<AccessState>("/api/settings/access"),
        readJson<{ rules: NotificationRule[]; degraded?: boolean; reason?: string }>("/api/notifications/rules"),
      ]);
      if (cancelled) return;

      const [auth, license, telemetry, config, history, access, notifications] = results;
      if (auth.status === "fulfilled") setAuthStatus(auth.value);
      if (license.status === "fulfilled") setLicenseStatus(license.value);
      if (telemetry.status === "fulfilled") setTelemetryPayload(telemetry.value);
      if (config.status === "fulfilled") setSystemConfig(config.value);
      if (history.status === "fulfilled") setConfigHistory(history.value.history || []);
      if (access.status === "fulfilled" && Array.isArray(access.value.users)) setAccessState(access.value);
      if (notifications.status === "fulfilled") {
        setNotificationRules(notifications.value.rules || []);
        setNotificationError(notifications.value.degraded ? notifications.value.reason ?? "Notifications are degraded." : null);
      } else {
        setNotificationError(notifications.reason instanceof Error ? notifications.reason.message : "Notification rules could not be loaded.");
      }

      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length === results.length) {
        setError("Settings data could not be loaded.");
      }
      setLoading(false);
    }

    loadSettings().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveConfig = async () => {
    if (!systemConfig) return;
    
    try {
      setSaving(true);
      setSaveMessage(null);
      const response = await authFetch('/api/system-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(systemConfig)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setSaveMessage(data?.data?.message ?? data?.message ?? 'Configuration saved successfully');
        const freshHistory = await readJson<{ history: SystemConfigHistory[] }>("/api/system-config/history").catch(() => null);
        if (freshHistory) setConfigHistory(freshHistory.history || []);
      } else {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
    } catch (error) {
      console.error('Error saving config:', error);
      setSaveMessage(error instanceof Error ? error.message : 'Error saving configuration');
    } finally {
      setSaving(false);
    }
  };

  const applyThemePreference = (nextTheme: ThemePref) => {
    setThemePref(nextTheme);
    localStorage.setItem("tib-theme", nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
  };

  const applyVariantPreference = (nextVariant: VariantPref) => {
    setVariantPref(nextVariant);
    localStorage.setItem("tib-variant", nextVariant);
    document.documentElement.setAttribute("data-variant", nextVariant);
  };

  const applyPollInterval = (nextInterval: number) => {
    setPollIntervalMs(nextInterval);
    localStorage.setItem(DEFAULT_POLL_KEY, String(nextInterval));
  };

  const handleNotificationRuleToggle = async (rule: NotificationRule, enabled: boolean) => {
    setNotificationError(null);
    setNotificationMessage(null);
    try {
      const response = await authFetch(`/api/notifications/rules/${rule.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: rule.kind,
          enabled,
          threshold: rule.threshold,
          channels: rule.channels,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
      const updated = (json?.data?.rules ?? json?.rules ?? []) as NotificationRule[];
      setNotificationRules((current) => current.map((item) => updated.find((next) => next.id === item.id) ?? item));
      setNotificationMessage(`${rule.kind} notifications ${enabled ? "enabled" : "disabled"}.`);
    } catch (err) {
      setNotificationError(err instanceof Error ? err.message : "Notification rule could not be updated.");
    }
  };

  const handleTelemetryConsent = async (consent: boolean) => {
    const response = await authFetch("/api/telemetry/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consent }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(json?.error || `Telemetry consent update failed with HTTP ${response.status}`);
      return;
    }
    setTelemetryConsent({ consented: consent, updatedAt: new Date().toISOString() });
  };

  const handleFinanceAgentChange = (field: keyof NonNullable<SystemConfig['config']['financeAgent']>, value: any) => {
    setSystemConfig(prev => ({
      ...prev!,
      config: {
        ...prev!.config,
        financeAgent: {
          ...prev!.config.financeAgent,
          [field]: value
        }
      }
    }));
  };

  const handlePipelineStageChange = (stage: string, field: string, value: any) => {
    setSystemConfig(prev => ({
      ...prev!,
      config: {
        ...prev!.config,
        pipelineStages: {
          ...prev!.config.pipelineStages,
          [stage]: {
            ...prev!.config.pipelineStages![stage as keyof typeof prev.config.pipelineStages],
            [field]: value
          }
        }
      }
    }));
  };

  const handleAlertThresholdChange = (field: string, value: number) => {
    setSystemConfig(prev => ({
      ...prev!,
      config: {
        ...prev!.config,
        alertThresholds: {
          ...prev!.config.alertThresholds,
          [field]: value
        }
      }
    }));
  };

  const handleAutoPublishChange = (field: string, value: any) => {
    setSystemConfig(prev => ({
      ...prev!,
      config: {
        ...prev!.config,
        autoPublish: {
          ...prev!.config.autoPublish,
          [field]: value
        }
      }
    }));
  };

  const refreshAccess = async () => {
    const response = await authFetch("/api/settings/access");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Access settings could not be loaded.");
    }
    setAccessState(data);
  };

  const handleInviteUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setAccessMessage(null);
    setAccessError(null);
    try {
      const response = await authFetch("/api/settings/access/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inviteForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The user could not be invited.");
      setInviteForm({ email: "", name: "", password: "", role: "viewer" });
      setAccessMessage("User access was saved.");
      await refreshAccess();
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : "The user could not be invited.");
    }
  };

  const handleRoleChange = async (userId: string, role: AccessRole) => {
    setAccessMessage(null);
    setAccessError(null);
    try {
      const response = await authFetch(`/api/settings/access/users/${encodeURIComponent(userId)}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The role could not be changed.");
      setAccessMessage("Role updated.");
      await refreshAccess();
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : "The role could not be changed.");
    }
  };

  if (loading) return <div className="loading-dim">loading…</div>;
  if (error) return <div className="loading-dim error">error: {error}</div>;

  return (
    <div className="dash-page">
      <div className="page-header settings-page-header">
        <div className="page-title">
          <h1>Settings</h1>
        </div>
      </div>

      <div className="dash-tabs settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`dash-tab ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
            role="tab"
            aria-selected={activeTab === t.id}
          >
            {t.label}
          </button>
        ))}
      </div>

      {saveMessage && <div className="settings-save-message">{saveMessage}</div>}

      {activeTab === "preferences" && (
        <div className="settings-grid">
          <WCard>
            <div className="settings-card-title">Appearance</div>
            <div className="settings-control-row">
              <div>
                <div className="w-label">Theme</div>
                <div className="w-caption">Persisted in localStorage as tib-theme.</div>
              </div>
              <div className="settings-segmented">
                <button className={`btn btn-sm ${themePref === "dark" ? "btn-primary" : "btn-ghost"}`} onClick={() => applyThemePreference("dark")}>Dark</button>
                <button className={`btn btn-sm ${themePref === "light" ? "btn-primary" : "btn-ghost"}`} onClick={() => applyThemePreference("light")}>Light</button>
              </div>
            </div>
            <div className="settings-control-row">
              <div>
                <div className="w-label">Variant</div>
                <div className="w-caption">Matches the compact/terminal switch in the top navigation.</div>
              </div>
              <div className="settings-segmented">
                <button className={`btn btn-sm ${variantPref === "terminal" ? "btn-primary" : "btn-ghost"}`} onClick={() => applyVariantPreference("terminal")}>Terminal</button>
                <button className={`btn btn-sm ${variantPref === "compact" ? "btn-primary" : "btn-ghost"}`} onClick={() => applyVariantPreference("compact")}>Compact</button>
              </div>
            </div>
          </WCard>

          <WCard>
            <div className="settings-card-title">Context</div>
            <label className="settings-field">
              <span>Default tenant</span>
              <input value={tenantId} onChange={(event) => setTenantId(event.target.value || "mimule")} />
            </label>
            <label className="settings-field">
              <span>Default project</span>
              <input value={projectId} onChange={(event) => setProjectId(event.target.value || "opencode-control-surface")} />
            </label>
            <div className="w-caption">These values are sent as x-tenant-id and x-project-id by authFetch.</div>
          </WCard>

          <WCard>
            <div className="settings-card-title">Refresh</div>
            <div className="settings-control-row">
              <div>
                <div className="w-label">Default polling interval</div>
                <div className="w-caption">Used by shared API hooks when a page does not set a custom interval.</div>
              </div>
              <select value={pollIntervalMs} onChange={(event) => applyPollInterval(Number(event.target.value))}>
                {DEFAULT_POLL_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option / 1000}s</option>
                ))}
              </select>
            </div>
          </WCard>

          <WCard>
            <div className="settings-card-title">Notifications</div>
            {notificationMessage && <div className="w-caption settings-success">{notificationMessage}</div>}
            {notificationError && <div className="w-caption settings-error">{notificationError}</div>}
            {notificationRules.length > 0 ? (
              <div className="settings-rule-list">
                {notificationRules.map((rule) => (
                  <div className="settings-rule-row" key={rule.id}>
                    <div>
                      <div className="w-label">{rule.kind}</div>
                      <div className="w-caption">Channels: {formatUnknownList(rule.channels)} · updated {new Date(rule.updatedAt).toLocaleString()}</div>
                    </div>
                    <label className="settings-switch">
                      <input type="checkbox" checked={rule.enabled} onChange={(event) => handleNotificationRuleToggle(rule, event.target.checked)} />
                      <span>{rule.enabled ? "Enabled" : "Disabled"}</span>
                    </label>
                  </div>
                ))}
              </div>
            ) : (
              <div className="w-caption">No notification rules are configured in the dashboard database.</div>
            )}
          </WCard>
        </div>
      )}

      {activeTab === "auth" && (
        <>
      {/* Auth Status */}
      <div className="dash-section">
        <div className="dash-section-title">auth status</div>
        <WCard>
          <div className="w-row">
            <span className="w-label">Operator token</span>
            <Pill color={authStatus?.tokenSet ? "green" : "red"}>
              {authStatus?.tokenSet ? "set ✓" : "not set ✗"}
            </Pill>
          </div>
          <div className="w-row">
            <span className="w-label">Dashboard DB</span>
            <Pill color={authStatus?.dashboardDbEnabled ? "green" : "gray"}>
              {authStatus?.dashboardDbEnabled ? "enabled" : "disabled"}
            </Pill>
          </div>
          <div className="w-row">
            <span className="w-label">Production mode</span>
            <Pill color={authStatus?.productionMode ? "green" : "gray"}>
              {authStatus?.productionMode ? "yes" : "no"}
            </Pill>
          </div>
          {authStatus?.note && (
            <div className="w-caption" style={{ marginTop: 8 }}>{authStatus.note}</div>
          )}
        </WCard>
      </div>

      {/* Action Allowlist Status */}
      <div className="dash-section">
        <div className="dash-section-title">action allowlist status</div>
        <WCard>
          <div className="w-caption">
            Allowlists are managed in server code and require a deploy to change.
            See <span className="w-label">server/api/actions.ts</span>.
          </div>
        </WCard>
      </div>
        </>
      )}

      {activeTab === "access" && (
        <div className="dash-section">
          <div className="dash-section-title">Access</div>
          <WCard style={{ marginBottom: 16 }}>
            <div className="w-row">
              <span className="w-label">Your role</span>
              <Pill color={accessState?.currentRole === "owner" ? "green" : "blue"}>
                {accessState?.currentRole ?? "viewer"}
              </Pill>
            </div>
            <div className="w-caption">Owners can invite users and change roles. Auditors and viewers can only review access.</div>
          </WCard>

          {accessMessage && <div className="w-caption" style={{ color: "var(--success)", marginBottom: 12 }}>{accessMessage}</div>}
          {accessError && <div className="w-caption" style={{ color: "var(--danger)", marginBottom: 12 }}>{accessError}</div>}

          <WCard style={{ marginBottom: 16 }}>
            <form onSubmit={handleInviteUser}>
              <div className="dash-section-title" style={{ marginBottom: 12 }}>Invite user</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                <input
                  type="email"
                  value={inviteForm.email}
                  onChange={(e) => setInviteForm(prev => ({ ...prev, email: e.target.value }))}
                  placeholder="email"
                  className="flex-1 px-2 py-1 border rounded"
                  required
                />
                <input
                  type="text"
                  value={inviteForm.name}
                  onChange={(e) => setInviteForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="name"
                  className="flex-1 px-2 py-1 border rounded"
                />
                <input
                  type="password"
                  value={inviteForm.password}
                  onChange={(e) => setInviteForm(prev => ({ ...prev, password: e.target.value }))}
                  placeholder="temporary password"
                  className="flex-1 px-2 py-1 border rounded"
                  minLength={8}
                  required
                />
                <select
                  value={inviteForm.role}
                  onChange={(e) => setInviteForm(prev => ({ ...prev, role: e.target.value as AccessRole }))}
                  className="flex-1 px-2 py-1 border rounded"
                >
                  <option value="viewer">viewer</option>
                  <option value="auditor">auditor</option>
                  <option value="operator">operator</option>
                  <option value="owner">owner</option>
                </select>
              </div>
              <div className="flex justify-end mt-4">
                <button className="btn btn-primary" type="submit">Invite user</button>
              </div>
            </form>
          </WCard>

          <div className="dash-section-title" style={{ marginBottom: 8 }}>Users and roles</div>
          {accessState?.users?.length ? (
            accessState.users.map((user) => (
              <WCard key={user.id} style={{ marginBottom: 8, padding: "10px 12px" }}>
                <div className="w-row" style={{ gap: 12, alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div className="w-label">{user.name || user.email}</div>
                    <div className="w-caption">{user.email} · {user.authMethod} · {new Date(user.createdAt).toLocaleDateString()}</div>
                  </div>
                  <select
                    value={user.role}
                    onChange={(e) => handleRoleChange(user.id, e.target.value as AccessRole)}
                    className="px-2 py-1 border rounded"
                    aria-label={`Role for ${user.email}`}
                  >
                    <option value="viewer">viewer</option>
                    <option value="auditor">auditor</option>
                    <option value="operator">operator</option>
                    <option value="owner">owner</option>
                  </select>
                </div>
              </WCard>
            ))
          ) : (
            <WCard>
              <div className="w-caption">No local users have been invited yet.</div>
            </WCard>
          )}
        </div>
      )}

      {activeTab === "license" && (
        <div className="dash-section">
          <div className="dash-section-title">license</div>
          <WCard>
            <div className="w-row">
              <span className="w-label">Tier</span>
              <Pill color={licenseStatus?.licensed ? "green" : "gray"}>
                {licenseStatus?.tier ?? "unknown"}
              </Pill>
            </div>
            {licenseStatus?.tenantId && (
              <div className="w-row">
                <span className="w-label">Tenant ID</span>
                <span className="w-mono" style={{ fontSize: 11 }}>{licenseStatus.tenantId}</span>
              </div>
            )}
            {licenseStatus?.issuedAt && (
              <div className="w-row">
                <span className="w-label">Issued</span>
                <span className="w-caption">{new Date(licenseStatus.issuedAt).toLocaleDateString()}</span>
              </div>
            )}
            {licenseStatus?.expiresAt && (
              <div className="w-row">
                <span className="w-label">Expires</span>
                <span className="w-caption">{new Date(licenseStatus.expiresAt).toLocaleDateString()}</span>
              </div>
            )}
            <div className="w-row" style={{ marginTop: 8 }}>
              <span className="w-label">License file</span>
              <span className="w-mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {licenseStatus?.licensed ? "/etc/opencode-license.d/v3.yaml" : "not present"}
              </span>
            </div>
          </WCard>

          <div className="dash-section-title" style={{ marginTop: 24 }}>feature list</div>
          <WCard>
            {licenseStatus?.features && licenseStatus.features.length > 0 ? (
              licenseStatus.features.map((f, i) => (
                <div key={i} className="w-row">
                  <Pill color="blue">{f}</Pill>
                </div>
              ))
            ) : (
              <div className="w-caption">No additional features — running in solo mode.</div>
            )}
          </WCard>
        </div>
      )}

      {activeTab === "telemetry" && (
        <div className="dash-section">
          <div className="dash-section-title">telemetry</div>
          <WCard>
            <div className="w-row">
              <span className="w-label">Opt-in status</span>
              <Pill color={telemetryConsent?.consented ? "green" : "gray"}>
                {telemetryConsent ? (telemetryConsent.consented ? "opted in" : "not opted in") : "not readable"}
              </Pill>
            </div>
            {telemetryConsent?.updatedAt && (
              <div className="w-row">
                <span className="w-label">Last updated</span>
                <span className="w-caption">{new Date(telemetryConsent.updatedAt).toLocaleString()}</span>
              </div>
            )}
            <div className="settings-action-row">
              <button className="btn btn-primary btn-sm" onClick={() => handleTelemetryConsent(true)}>Opt in</button>
              <button className="btn btn-ghost btn-sm" onClick={() => handleTelemetryConsent(false)}>Opt out</button>
            </div>
          </WCard>

          <div className="dash-section-title" style={{ marginTop: 24 }}>preview payload</div>
          <WCard>
            <pre style={{ fontSize: 10, fontFamily: "var(--mono)", whiteSpace: "pre-wrap", overflowX: "auto" }}>
              {JSON.stringify(telemetryPayload ?? {}, null, 2)}
            </pre>
          </WCard>
        </div>
      )}

      {activeTab === "finance" && systemConfig && (
        <div className="dash-section">
          <div className="dash-section-title">Finance Agent Settings</div>
          <WCard>
            <div className="w-row">
              <span className="w-label">Enabled</span>
              <input
                type="checkbox"
                checked={systemConfig.config.financeAgent?.enabled}
                onChange={(e) => handleFinanceAgentChange('enabled', e.target.checked)}
                className="ml-2"
              />
            </div>
            <div className="w-row">
              <span className="w-label">Model Override</span>
              <input
                type="text"
                value={systemConfig.config.financeAgent?.modelOverride || ''}
                onChange={(e) => handleFinanceAgentChange('modelOverride', e.target.value)}
                placeholder="Leave empty to use default"
                className="flex-1 ml-2 px-2 py-1 border rounded"
              />
            </div>
            <div className="w-row">
              <span className="w-label">Processing Timeout (ms)</span>
              <input
                type="number"
                value={systemConfig.config.financeAgent?.processingTimeout || 300000}
                onChange={(e) => handleFinanceAgentChange('processingTimeout', Number(e.target.value))}
                className="flex-1 ml-2 px-2 py-1 border rounded"
              />
            </div>
          </WCard>
          <div className="flex justify-end mt-4">
            <button 
              className="btn btn-primary" 
              onClick={handleSaveConfig}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Finance Settings'}
            </button>
          </div>
        </div>
      )}

      {activeTab === "pipeline" && systemConfig && (
        <div className="dash-section">
          <div className="dash-section-title">Pipeline Stage Configuration</div>
          
          {Object.entries(systemConfig.config.pipelineStages || {}).map(([stage, config]) => (
            <WCard key={stage} style={{ marginBottom: '16px' }}>
              <div className="w-row">
                <span className="w-label" style={{ fontWeight: 'bold', textTransform: 'capitalize' }}>{stage}</span>
              </div>
              <div className="w-row">
                <span className="w-label">Model</span>
                <input
                  type="text"
                  value={config?.model || ''}
                  onChange={(e) => handlePipelineStageChange(stage, 'model', e.target.value)}
                  className="flex-1 ml-2 px-2 py-1 border rounded"
                />
              </div>
              <div className="w-row">
                <span className="w-label">Enabled</span>
                <input
                  type="checkbox"
                  checked={config?.enabled}
                  onChange={(e) => handlePipelineStageChange(stage, 'enabled', e.target.checked)}
                  className="ml-2"
                />
              </div>
              <div className="w-row">
                <span className="w-label">Timeout (ms)</span>
                <input
                  type="number"
                  value={config?.timeout}
                  onChange={(e) => handlePipelineStageChange(stage, 'timeout', Number(e.target.value))}
                  className="flex-1 ml-2 px-2 py-1 border rounded"
                />
              </div>
            </WCard>
          ))}
          
          <div className="flex justify-end mt-4">
            <button 
              className="btn btn-primary" 
              onClick={handleSaveConfig}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Pipeline Settings'}
            </button>
          </div>
        </div>
      )}

      {activeTab === "alerts" && systemConfig && (
        <div className="dash-section">
          <div className="dash-section-title">Alert Thresholds</div>
          <WCard>
            <div className="w-row">
              <span className="w-label">Pipeline Failure Rate</span>
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={systemConfig.config.alertThresholds?.pipelineFailureRate}
                onChange={(e) => handleAlertThresholdChange('pipelineFailureRate', Number(e.target.value))}
                className="flex-1 ml-2 px-2 py-1 border rounded"
              />
            </div>
            <div className="w-row">
              <span className="w-label">Model Response Time (ms)</span>
              <input
                type="number"
                value={systemConfig.config.alertThresholds?.modelResponseTimeMs}
                onChange={(e) => handleAlertThresholdChange('modelResponseTimeMs', Number(e.target.value))}
                className="flex-1 ml-2 px-2 py-1 border rounded"
              />
            </div>
            <div className="w-row">
              <span className="w-label">GPU Utilization</span>
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={systemConfig.config.alertThresholds?.gpuUtilization}
                onChange={(e) => handleAlertThresholdChange('gpuUtilization', Number(e.target.value))}
                className="flex-1 ml-2 px-2 py-1 border rounded"
              />
            </div>
          </WCard>
          <div className="flex justify-end mt-4">
            <button 
              className="btn btn-primary" 
              onClick={handleSaveConfig}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Alert Settings'}
            </button>
          </div>
        </div>
      )}

      {activeTab === "approval" && systemConfig && (
        <div className="dash-section">
          <div className="dash-section-title">Auto-publish & Approval Settings</div>
          <WCard>
            <div className="w-row">
              <span className="w-label">Auto-publish Enabled</span>
              <input
                type="checkbox"
                checked={systemConfig.config.autoPublish?.enabled}
                onChange={(e) => handleAutoPublishChange('enabled', e.target.checked)}
                className="ml-2"
              />
            </div>
            <div className="w-row">
              <span className="w-label">Auto-publish Verticals</span>
              <textarea
                value={(systemConfig.config.autoPublish?.verticals || []).join(', ')}
                onChange={(e) => handleAutoPublishChange('verticals', e.target.value.split(',').map(item => item.trim()))}
                className="flex-1 ml-2 px-2 py-1 border rounded"
                rows={3}
              />
            </div>
            <div className="w-row">
              <span className="w-label">Approval Required Verticals</span>
              <textarea
                value={(systemConfig.config.autoPublish?.approvalRequired || []).join(', ')}
                onChange={(e) => handleAutoPublishChange('approvalRequired', e.target.value.split(',').map(item => item.trim()))}
                className="flex-1 ml-2 px-2 py-1 border rounded"
                rows={2}
              />
            </div>
          </WCard>
          
          <div className="dash-section-title" style={{ marginTop: 24 }}>Approval Workflows</div>
          <WCard>
            <div className="w-row">
              <span className="w-label">Approval Workflows Enabled</span>
              <input
                type="checkbox"
                checked={systemConfig.config.approvalWorkflows?.enabled}
                onChange={(e) => setSystemConfig(prev => ({
                  ...prev!,
                  config: {
                    ...prev!.config,
                    approvalWorkflows: {
                      ...prev!.config.approvalWorkflows,
                      enabled: e.target.checked
                    }
                  }
                }))}
                className="ml-2"
              />
            </div>
            <div className="w-row">
              <span className="w-label">Required Verticals</span>
              <textarea
                value={(systemConfig.config.approvalWorkflows?.requiredVerticals || []).join(', ')}
                onChange={(e) => setSystemConfig(prev => ({
                  ...prev!,
                  config: {
                    ...prev!.config,
                    approvalWorkflows: {
                      ...prev!.config.approvalWorkflows,
                      requiredVerticals: e.target.value.split(',').map(item => item.trim())
                    }
                  }
                }))}
                className="flex-1 ml-2 px-2 py-1 border rounded"
                rows={2}
              />
            </div>
            <div className="w-row">
              <span className="w-label">Max Articles Per Day</span>
              <input
                type="number"
                value={systemConfig.config.approvalWorkflows?.maxArticlesPerDay}
                onChange={(e) => setSystemConfig(prev => ({
                  ...prev!,
                  config: {
                    ...prev!.config,
                    approvalWorkflows: {
                      ...prev!.config.approvalWorkflows,
                      maxArticlesPerDay: Number(e.target.value)
                    }
                  }
                }))}
                className="flex-1 ml-2 px-2 py-1 border rounded"
              />
            </div>
          </WCard>
          <div className="flex justify-end mt-4">
            <button 
              className="btn btn-primary" 
              onClick={handleSaveConfig}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Approval Settings'}
            </button>
          </div>
        </div>
      )}

      {activeTab === "history" && (
        <div className="dash-section">
          <div className="dash-section-title">Configuration History</div>
          {configHistory.length > 0 ? (
            configHistory.map((item, index) => (
              <WCard key={item.id} style={{ marginBottom: '8px' }}>
                <div className="w-row">
                  <span className="w-label">{new Date(item.timestamp).toLocaleString()}</span>
                  <Pill color="blue">{item.changedBy}</Pill>
                </div>
                <div className="w-caption">{item.changes.join(', ')}</div>
              </WCard>
            ))
          ) : (
            <WCard>
              <div className="w-caption">No configuration history available.</div>
            </WCard>
          )}
        </div>
      )}
    </div>
  );
}

function formatUnknownList(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ") || "none";
  if (value == null) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
