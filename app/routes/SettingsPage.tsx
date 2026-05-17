import { useState, useEffect } from "react";

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

type TabId = "auth" | "license" | "telemetry";

const TABS: { id: TabId; label: string }[] = [
  { id: "auth", label: "Auth & Stack" },
  { id: "license", label: "License" },
  { id: "telemetry", label: "Telemetry" },
];

export function SettingsPage() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [telemetryPayload, setTelemetryPayload] = useState<TelemetryPayload | null>(null);
  const [telemetryConsent, setTelemetryConsent] = useState<TelemetryConsent | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("auth");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRoot[]>(FALLBACK_WORKSPACES);

  useEffect(() => {
    fetch("/api/settings/auth-status")
      .then(res => res.json())
      .then(data => {
        setAuthStatus(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
    fetch("/api/licensing/status")
      .then(res => res.json())
      .then(setLicenseStatus)
      .catch(() => {});
    fetch("/api/telemetry/preview")
      .then(res => res.json())
      .then(setTelemetryPayload)
      .catch(() => {});
    fetch("/api/telemetry/consent")
      .then(res => res.json())
      .then(setTelemetryConsent)
      .catch(() => {});
  }, []);

  useEffect(() => {
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
    </div>
  );
}