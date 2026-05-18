import { useState } from "react";
import { FolderOpen, Plus, RefreshCw, Search, Edit2, X, CheckCircle2 } from "lucide-react";
import { useAuthApi } from "../hooks/useAuthApi";
import { authFetch } from "../lib/authFetch";
import { getActiveTenantId } from "../hooks/useTenantContext";

interface Project {
  id: string;
  tenantId: string;
  name: string;
  repoPath: string;
  language: string;
  framework: string;
  validatorCommands: string[];
  status: string;
}

interface DetectedConfig {
  language?: string;
  framework?: string;
  validatorCommands?: string[];
}

interface ProjectFormData {
  name: string;
  repoPath: string;
  language: string;
  framework: string;
  validatorCommands: string;
}

const EMPTY_FORM: ProjectFormData = {
  name: "",
  repoPath: "",
  language: "",
  framework: "",
  validatorCommands: "",
};

function langColor(lang: string): string {
  switch (lang.toLowerCase()) {
    case "typescript": return "badge-blue";
    case "javascript": return "badge-yellow";
    case "python": return "badge-green";
    case "go": return "badge-cyan";
    case "rust": return "badge-orange";
    default: return "badge-gray";
  }
}

export function ProjectsPage() {
  const tenantId = getActiveTenantId();
  const { data, loading, error, refresh } = useAuthApi<{ projects: Project[] }>(
    "/api/projects"
  );

  const [detectPath, setDetectPath] = useState("");
  const [detectResult, setDetectResult] = useState<DetectedConfig | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [form, setForm] = useState<ProjectFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleDetect() {
    if (!detectPath.trim()) return;
    setDetecting(true);
    setDetectError(null);
    setDetectResult(null);
    try {
      const res = await authFetch("/api/projects/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: detectPath.trim() }),
      });
      const json = await res.json() as { detected?: DetectedConfig; error?: string };
      if (!res.ok) {
        setDetectError(json.error ?? "Detection failed");
      } else {
        const partial = json.detected ?? {};
        setDetectResult(partial);
        setForm((f) => ({
          ...f,
          repoPath: detectPath.trim(),
          language: partial.language ?? f.language,
          framework: partial.framework ?? f.framework,
          validatorCommands: (partial.validatorCommands ?? []).join(", ") || f.validatorCommands,
        }));
        setShowCreateModal(true);
      }
    } catch {
      setDetectError("Network error");
    } finally {
      setDetecting(false);
    }
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setDetectResult(null);
    setSaveError(null);
    setShowCreateModal(true);
  }

  function openEdit(p: Project) {
    setEditProject(p);
    setForm({
      name: p.name,
      repoPath: p.repoPath,
      language: p.language,
      framework: p.framework,
      validatorCommands: p.validatorCommands.join(", "),
    });
    setSaveError(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    const body = {
      name: form.name.trim(),
      tenantId,
      repoPath: form.repoPath.trim(),
      language: form.language.trim(),
      framework: form.framework.trim(),
      validatorCommands: form.validatorCommands.split(",").map((s) => s.trim()).filter(Boolean),
    };
    try {
      let res: Response;
      if (editProject) {
        res = await authFetch(`/api/projects/${editProject.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        res = await authFetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const json = await res.json() as { error?: string };
        setSaveError(json.error ?? "Save failed");
      } else {
        setShowCreateModal(false);
        setEditProject(null);
        refresh();
      }
    } catch {
      setSaveError("Network error");
    } finally {
      setSaving(false);
    }
  }

  const projects = data?.projects ?? [];

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-header-left">
          <FolderOpen size={20} strokeWidth={1.5} />
          <h2>Projects</h2>
          <span className="page-header-sub">Registered repositories for tenant <code>{tenantId}</code></span>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-ghost btn-sm" onClick={refresh} title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button className="btn btn-primary btn-sm" onClick={openCreate}>
            <Plus size={14} /> New Project
          </button>
        </div>
      </div>

      {/* Detect bar */}
      <div className="detect-bar">
        <Search size={14} className="detect-bar-icon" />
        <input
          className="detect-bar-input"
          placeholder="Repo path to detect (e.g. /opt/opencode-control-surface)"
          value={detectPath}
          onChange={(e) => setDetectPath(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleDetect(); }}
        />
        <button className="btn btn-sm btn-secondary" onClick={handleDetect} disabled={detecting}>
          {detecting ? "Detecting…" : "Detect & Import"}
        </button>
      </div>
      {detectError && <p className="error-note">{detectError}</p>}

      {loading && <p className="loading-note">Loading…</p>}
      {error && <p className="error-note">{error}</p>}

      {!loading && projects.length === 0 && (
        <div className="empty-state">
          <FolderOpen size={40} strokeWidth={1} />
          <p>No projects yet — click <strong>New Project</strong> to register a repo</p>
        </div>
      )}

      {projects.length > 0 && (
        <div className="project-list">
          {projects.map((p) => (
            <div key={p.id} className="project-card">
              <div className="project-card-header">
                <span className="project-name">{p.name}</span>
                <div className="project-badges">
                  <span className={`badge ${langColor(p.language)}`}>{p.language}</span>
                  <span className="badge badge-gray">{p.framework}</span>
                </div>
                <button className="btn btn-ghost btn-xs" onClick={() => openEdit(p)} title="Edit">
                  <Edit2 size={13} />
                </button>
              </div>
              <div className="project-card-body">
                <span className="project-repo-path">{p.repoPath}</span>
                {p.validatorCommands.length > 0 && (
                  <div className="project-validators">
                    {p.validatorCommands.map((cmd, i) => (
                      <code key={i} className="validator-cmd">{cmd}</code>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit modal */}
      {(showCreateModal || editProject) && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-header">
              <h3>{editProject ? "Edit Project" : "New Project"}</h3>
              <button className="btn btn-ghost btn-xs" onClick={() => { setShowCreateModal(false); setEditProject(null); }}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              {detectResult && (
                <div className="detect-success-note">
                  <CheckCircle2 size={14} /> Auto-detected config applied
                </div>
              )}
              {[
                { label: "Name", field: "name" as const, placeholder: "Control Surface" },
                { label: "Repo Path", field: "repoPath" as const, placeholder: "/opt/my-repo" },
                { label: "Language", field: "language" as const, placeholder: "typescript" },
                { label: "Framework", field: "framework" as const, placeholder: "bun+react" },
                { label: "Validator Commands (comma-separated)", field: "validatorCommands" as const, placeholder: "bun run check, bun test" },
              ].map(({ label, field, placeholder }) => (
                <label key={field} className="form-field">
                  <span className="form-label">{label}</span>
                  <input
                    className="form-input"
                    placeholder={placeholder}
                    value={form[field]}
                    onChange={(e) => setForm((f) => ({ ...f, [field]: e.currentTarget.value }))}
                  />
                </label>
              ))}
              {saveError && <p className="error-note">{saveError}</p>}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => { setShowCreateModal(false); setEditProject(null); }}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving || !form.name.trim()}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
