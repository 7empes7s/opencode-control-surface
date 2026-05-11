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

export function SettingsPage() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
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
    </div>
  );
}