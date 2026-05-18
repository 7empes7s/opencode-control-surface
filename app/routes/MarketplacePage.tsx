import { useState } from "react";
import { Package, Play, Trash2, Ban, Plus, X, AlertCircle, Clock } from "lucide-react";
import { useAuthApi } from "../hooks/useAuthApi";
import { authFetch } from "../lib/authFetch";
import { SectionCard } from "../components/SectionCard";
import type { InstalledSkill } from "../../server/marketplace/types";

interface MarketplaceData {
  skills: InstalledSkill[];
}

interface RunHistoryEntry {
  id: string;
  skillId: string;
  instanceId: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  outputJson: string | null;
  error: string | null;
}

interface RunsData {
  runs: RunHistoryEntry[];
}

function SkillStatusBadge({ status }: { status: string }) {
  const color = status === "active" ? "green" : status === "disabled" ? "amber" : "red";
  return <span className={`pill ${color}`}>{status}</span>;
}

function KindBadge({ kind }: { kind: string }) {
  return <span className="pill gray">{kind}</span>;
}

function fmtAge(ts: number): string {
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function fmtDuration(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt ?? Date.now();
  const ms = Math.max(0, end - startedAt);
  if (ms < 1000) return "<1s";
  return `${Math.round(ms / 1000)}s`;
}

type Modal =
  | { type: "run"; skill: InstalledSkill }
  | { type: "install" };

export function MarketplacePage() {
  const { data, loading, error, refresh } = useAuthApi<MarketplaceData>("/api/marketplace/skills", 30_000);
  const [modal, setModal] = useState<Modal | null>(null);
  const [runInput, setRunInput] = useState("{}");
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [installPath, setInstallPath] = useState("");
  const [installManifest, setInstallManifest] = useState("");
  const [installError, setInstallError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [uninstallConfirmId, setUninstallConfirmId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [runsData, setRunsData] = useState<RunsData | null>(null);

  const skills = data?.skills ?? [];

  async function handleRun(skill: InstalledSkill) {
    setModal({ type: "run", skill });
    let defaultInput: Record<string, unknown> = {};
    try {
      const manifest = JSON.parse(skill.manifestJson);
      defaultInput = manifest.inputs
        ? Object.fromEntries(Object.keys(manifest.inputs).map((k) => [k, ""]))
        : {};
    } catch { /* use empty */ }
    setRunInput(JSON.stringify(defaultInput, null, 2));
    setRunOutput(null);
    setRunError(null);
    setSelectedSkill(skill.id);
    try {
      const res = await authFetch(`/api/marketplace/skills/${skill.id}/runs`);
      if (res.ok) {
        const d = await res.json();
        setRunsData(d.data);
      }
    } catch { /* ignore */ }
  }

  async function handleRunConfirm() {
    if (!modal || modal.type !== "run") return;
    setRunning(true);
    setRunOutput(null);
    setRunError(null);
    try {
      const input = JSON.parse(runInput);
      const res = await authFetch(`/api/marketplace/skills/${modal.skill.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const body = await res.json();
      if (res.ok) {
        setRunOutput(JSON.stringify(body.data.output, null, 2));
      } else {
        setRunError(body.data?.error ?? "Unknown error");
      }
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunning(false);
      refresh();
    }
  }

  async function handleDisable(skill: InstalledSkill) {
    await authFetch(`/api/marketplace/skills/${skill.id}`, { method: "DELETE" });
    refresh();
  }

  async function handleEnable(skill: InstalledSkill) {
    await authFetch(`/api/marketplace/skills/${skill.id}/enable`, { method: "POST" });
    refresh();
  }

  async function handleUninstall(skill: InstalledSkill) {
    if (uninstallConfirmId !== skill.id) {
      setUninstallConfirmId(skill.id);
      return;
    }
    await authFetch(`/api/marketplace/skills/${skill.id}`, { method: "DELETE" });
    refresh();
    setUninstallConfirmId(null);
  }

  async function handleInstall() {
    if (!installPath.trim() || !installManifest.trim()) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const manifestJson = JSON.stringify(JSON.parse(installManifest));
      const res = await authFetch("/api/marketplace/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath: installPath, manifestJson }),
      });
      const body = await res.json();
      if (res.ok) {
        setModal(null);
        setInstallPath("");
        setInstallManifest("");
        refresh();
      } else {
        setInstallError(body.data?.error ?? "Install failed");
      }
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;

  const echoSkill = skills.find((s) => s.name === "echo");

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Marketplace</div>
        <button
          className="btn btn-primary"
          onClick={() => setModal({ type: "install" })}
        >
          <Plus size={14} strokeWidth={1.75} />
          Install from Bundle
        </button>
      </div>

      {modal?.type === "install" && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="modal-head">
              <div className="modal-title">Install from Bundle</div>
              <button className="drawer-close" onClick={() => setModal(null)} aria-label="Close">
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="form-label">Bundle Path</label>
                <input
                  className="form-input"
                  placeholder="/path/to/skill-bundle"
                  value={installPath}
                  onChange={(e) => setInstallPath(e.target.value)}
                />
              </div>
              <div>
                <label className="form-label">Manifest JSON</label>
                <textarea
                  className="form-input"
                  style={{ minHeight: 200, fontFamily: "var(--mono)", fontSize: 12 }}
                  placeholder='{"name":"my-skill","version":"1.0.0",...}'
                  value={installManifest}
                  onChange={(e) => setInstallManifest(e.target.value)}
                />
              </div>
              {installError && (
                <div style={{ color: "var(--red)", fontSize: 13 }}>{installError}</div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={installing || !installPath || !installManifest}
                onClick={handleInstall}
              >
                {installing ? "Installing…" : "Install"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal?.type === "run" && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-head">
              <div className="modal-title">Run Skill: {modal.skill.name}</div>
              <button className="drawer-close" onClick={() => setModal(null)} aria-label="Close">
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="form-label">Input JSON</label>
                <textarea
                  className="form-input"
                  style={{ minHeight: 120, fontFamily: "var(--mono)", fontSize: 12 }}
                  value={runInput}
                  onChange={(e) => setRunInput(e.target.value)}
                />
              </div>
              {runOutput !== null && (
                <div>
                  <label className="form-label">Output</label>
                  <pre style={{
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: 10,
                    fontSize: 12,
                    fontFamily: "var(--mono)",
                    overflow: "auto",
                    maxHeight: 200,
                  }}>{runOutput}</pre>
                </div>
              )}
              {runError && (
                <div style={{ color: "var(--red)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertCircle size={14} />
                  {runError}
                </div>
              )}

              {runsData && runsData.runs.length > 0 && (
                <div>
                  <label className="form-label">Recent Runs</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {runsData.runs.slice(0, 5).map((r) => (
                      <div key={r.id} style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        background: "var(--bg-panel)", borderRadius: 4, padding: "6px 10px", fontSize: 12,
                      }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <SkillStatusBadge status={r.status} />
                          <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                            {r.instanceId.slice(0, 8)}…
                          </span>
                        </span>
                        <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                          {fmtAge(r.startedAt)} · {fmtDuration(r.startedAt, r.finishedAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setModal(null)}>Close</button>
              <button
                className="btn btn-primary"
                disabled={running}
                onClick={handleRunConfirm}
              >
                {running ? "Running…" : "Run"}
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard title="installed skills" id="skills" defaultOpen={true}>
        <div className="section-card-body" style={{ padding: "12px 14px" }}>
          {skills.length === 0 ? (
            <div className="empty-state">
              <Package size={24} strokeWidth={1.5} style={{ color: "var(--text-dim)", marginBottom: 8 }} />
              <div style={{ fontWeight: 500, marginBottom: 4 }}>No skills installed</div>
              <div className="dim" style={{ fontSize: 13 }}>
                The built-in echo skill is always available. Install a bundle to add more skills.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {skills.map((skill) => (
                <div key={skill.id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 12px",
                  background: "var(--bg-panel)",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 500 }}>{skill.name}</span>
                      <span className="dim" style={{ fontSize: 12 }}>v{skill.version}</span>
                      <KindBadge kind={skill.kind} />
                      <SkillStatusBadge status={skill.status} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                        installed {fmtAge(skill.installedAt)}
                      </span>
                      {skill.errorMessage && (
                        <span style={{ color: "var(--red)", fontSize: 11 }}>{skill.errorMessage}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn btn-sm btn-primary"
                      title="Run skill"
                      onClick={() => handleRun(skill)}
                      disabled={skill.status !== "active"}
                    >
                      <Play size={12} strokeWidth={1.75} />
                      Run
                    </button>
                    {skill.status === "active" ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        title="Disable skill"
                        onClick={() => handleDisable(skill)}
                      >
                        <Ban size={12} strokeWidth={1.75} />
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm btn-ghost"
                        title="Enable skill"
                        onClick={() => handleEnable(skill)}
                      >
                        <Play size={12} strokeWidth={1.75} />
                      </button>
                    )}
                    {uninstallConfirmId === skill.id ? (
                      <>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Remove?</span>
                        <button className="btn btn-sm btn-ghost" style={{ color: "var(--red)" }} onClick={() => handleUninstall(skill)}>Confirm</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => setUninstallConfirmId(null)}>Cancel</button>
                      </>
                    ) : (
                      <button
                        className="btn btn-sm btn-ghost"
                        title="Uninstall skill"
                        onClick={() => handleUninstall(skill)}
                        style={{ color: "var(--red)" }}
                      >
                        <Trash2 size={12} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      {echoSkill && skills.filter((s) => s.name !== "echo").length === 0 && (
        <SectionCard title="built-in echo skill" id="echo" defaultOpen={false}>
          <div className="section-card-body" style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>echo</div>
                <div className="dim" style={{ fontSize: 12 }}>Returns input as output — useful for testing</div>
              </div>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => handleRun(echoSkill)}
              >
                <Play size={12} strokeWidth={1.75} />
                Run
              </button>
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  );
}