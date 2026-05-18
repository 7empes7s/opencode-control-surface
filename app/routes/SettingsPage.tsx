import { useState, useEffect } from "react";
import { authFetch } from "../lib/authFetch";

interface AuthStatus {
  tokenSet: boolean;
  productionMode: boolean;
  dashboardDbEnabled: boolean;
  cloudflareHeadersPresent: boolean;
  note: string;
}

interface WorkspaceRoot {
  path: string;
  risk: string;
  liveService?: string;
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

function WCard({ children, className = "", style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`w-card ${className}`} style={style}>{children}</div>;
}

const FALLBACK_WORKSPACES: WorkspaceRoot[] = [
  { path: "/opt/newsbites", risk: "low", liveService: "newsbites.service" },
  { path: "/opt/mimoun", risk: "medium", liveService: "openclaw_gateway" },
  { path: "/opt/paperclip", risk: "medium", liveService: "paperclip" },
  { path: "/opt/opencode-control-surface", risk: "low", liveService: "control-surface.service" },
  { path: "/opt/dashboard-v2", risk: "low" },
  { path: "/opt/ai-vault", risk: "low" },
];

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: "green" | "red" | "amber" | "gray" | "blue" }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

type TabId = "auth" | "license" | "telemetry" | "finance" | "pipeline" | "alerts" | "approval" | "history";

const TABS: { id: TabId; label: string }[] = [
  { id: "auth", label: "Auth & Stack" },
  { id: "license", label: "License" },
  { id: "telemetry", label: "Telemetry" },
  { id: "finance", label: "Finance Agent" },
  { id: "pipeline", label: "Pipeline Stages" },
  { id: "alerts", label: "Alert Thresholds" },
  { id: "approval", label: "Auto-publish/Approval" },
  { id: "history", label: "Config History" },
];

export function SettingsPage() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [telemetryPayload, setTelemetryPayload] = useState<TelemetryPayload | null>(null);
  const [telemetryConsent, setTelemetryConsent] = useState<TelemetryConsent | null>(null);
  const [systemConfig, setSystemConfig] = useState<SystemConfig | null>(null);
  const [configHistory, setConfigHistory] = useState<SystemConfigHistory[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("auth");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRoot[]>(FALLBACK_WORKSPACES);

  useEffect(() => {
    Promise.all([
      authFetch("/api/settings/auth-status")
        .then(res => res.json())
        .then(setAuthStatus),
      authFetch("/api/licensing/status")
        .then(res => res.json())
        .then(setLicenseStatus),
      authFetch("/api/telemetry/preview")
        .then(res => res.json())
        .then(setTelemetryPayload),
      authFetch("/api/telemetry/consent")
        .then(res => res.json())
        .then(setTelemetryConsent),
      authFetch("/api/system-config")
        .then(res => res.json())
        .then(setSystemConfig),
      authFetch("/api/system-config/history")
        .then(res => res.json())
        .then(data => setConfigHistory(data.history || []))
    ])
    .then(() => setLoading(false))
    .catch(err => {
      setError(err.message);
      setLoading(false);
    });

    fetch("/var/lib/mimule/workspace-registry.json")
      .then(res => {
        if (res.ok) return res.json();
        throw new Error("not found");
      })
      .then(data => {
        if (Array.isArray(data)) {
          setWorkspaces(data);
        }
      })
      .catch(() => {
        // Use fallback
      });
  }, []);

  const handleSaveConfig = async () => {
    if (!systemConfig) return;
    
    try {
      setSaving(true);
      const response = await authFetch('/api/system-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(systemConfig)
      });
      
      if (response.ok) {
        alert('Configuration saved successfully');
      }
    } catch (error) {
      console.error('Error saving config:', error);
      alert('Error saving configuration');
    } finally {
      setSaving(false);
    }
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

  if (loading) return <div className="loading-dim">loading…</div>;
  if (error) return <div className="loading-dim error">error: {error}</div>;

  return (
    <div className="dash-page">
      <div className="dash-section">
        <div className="dash-section-title">Settings</div>
      </div>

      <div className="dash-tabs" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`dash-tab ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

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

      {/* Widget Preferences */}
      <div className="dash-section">
        <div className="dash-section-title">widget preferences</div>
        <WCard>
          <div className="w-caption">
            Widget preference storage coming in V4.1 — preferences will persist server-side via operator_state.
          </div>
        </WCard>
      </div>

      {/* Workspace Roots */}
      <div className="dash-section">
        <div className="dash-section-title">workspace roots</div>
        <div className="w-caption" style={{ marginBottom: 8 }}>
          Current workspaces in the MIMULE stack
        </div>
        {workspaces.map((ws, i) => (
          <WCard key={i} style={{ marginBottom: 8, padding: "8px 12px" }}>
            <div className="w-row">
              <span className="w-label" style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11 }}>
                {ws.path}
              </span>
              <Pill color={ws.risk === "low" ? "green" : ws.risk === "medium" ? "amber" : "red"}>
                {ws.risk}
              </Pill>
            </div>
            {ws.liveService && (
              <div className="w-caption">Service: {ws.liveService}</div>
            )}
          </WCard>
        ))}
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
                {telemetryConsent?.consented ? "opted in" : "not opted in"}
              </Pill>
            </div>
            {telemetryConsent?.updatedAt && (
              <div className="w-row">
                <span className="w-label">Last updated</span>
                <span className="w-caption">{new Date(telemetryConsent.updatedAt).toLocaleString()}</span>
              </div>
            )}
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
              className="btn-primary" 
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
              className="btn-primary" 
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
              className="btn-primary" 
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
              className="btn-primary" 
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