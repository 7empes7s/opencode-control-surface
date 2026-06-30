import { useState, useCallback } from "react";
import { Flag, Plus, Trash2, History, RefreshCw, X, ChevronDown, ChevronUp } from "lucide-react";
import { useAuthApi } from "../hooks/useAuthApi";
import { authFetch } from "../lib/authFetch";

interface FeatureFlag {
  id: string;
  key: string;
  label: string | null;
  description: string | null;
  enabled: boolean;
  rolloutPercentage: number;
  targetingJson: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  tenantId: string;
}

interface FlagHistory {
  id: number;
  ts: number;
  flagId: string;
  oldValueJson: string | null;
  newValueJson: string;
  changedBy: string;
  note: string | null;
}

function fmtDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function fmtAge(ts: number): string {
  const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function isStale(flag: FeatureFlag): boolean {
  const daysSinceUpdate = (Date.now() - flag.updatedAt) / (24 * 60 * 60 * 1000);
  return flag.enabled && flag.rolloutPercentage >= 100 && daysSinceUpdate > 30;
}

interface FlagModalProps {
  initial?: FeatureFlag | null;
  onClose: () => void;
  onSaved: () => void;
}

function FlagModal({ initial, onClose, onSaved }: FlagModalProps) {
  const isEdit = !!initial;
  const [key, setKey] = useState(initial?.key ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [rolloutPct, setRolloutPct] = useState(String(initial?.rolloutPercentage ?? 0));
  const [targetingJson, setTargetingJson] = useState(
    initial?.targetingJson ? JSON.stringify(JSON.parse(initial.targetingJson), null, 2) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    const pct = parseInt(rolloutPct, 10);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      setError("Rollout percentage must be 0–100");
      return;
    }
    let parsedTargeting: unknown = undefined;
    if (targetingJson.trim()) {
      try {
        parsedTargeting = JSON.parse(targetingJson);
      } catch {
        setError("Targeting JSON is invalid");
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        key: key.trim(),
        label: label.trim() || null,
        description: description.trim() || null,
        enabled,
        rolloutPercentage: pct,
      };
      if (parsedTargeting !== undefined) body.targetingJson = parsedTargeting;

      const url = isEdit ? `/api/feature-flags/${initial!.id}` : "/api/feature-flags";
      const method = isEdit ? "PATCH" : "POST";
      const res = await authFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [key, label, description, enabled, rolloutPct, targetingJson, isEdit, initial, onClose, onSaved]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: "var(--surface)", borderRadius: 12, padding: 28,
        width: "min(540px, 96vw)", maxHeight: "90vh", overflowY: "auto",
        border: "1px solid var(--border)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", margin: 0 }}>
            {isEdit ? "Edit feature flag" : "Create feature flag"}
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, minHeight: 44, minWidth: 44, color: "var(--text-muted)" }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Key <span style={{ color: "var(--accent)" }}>*</span></span>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="my-feature-flag"
              disabled={isEdit}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 14,
                opacity: isEdit ? 0.6 : 1,
              }}
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Alphanumeric, dashes, underscores, dots. Immutable once created.</span>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Label</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Human-readable name"
              style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 14 }}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this flag control?"
              rows={2}
              style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 14, resize: "vertical" }}
            />
          </label>

          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", minHeight: 44 }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                style={{ width: 18, height: 18, cursor: "pointer" }}
              />
              <span style={{ fontSize: 14, color: "var(--text)" }}>Enabled</span>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Rollout % (0–100)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={rolloutPct}
                onChange={(e) => setRolloutPct(e.target.value)}
                style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 14, width: "100%" }}
              />
            </label>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Targeting JSON <span style={{ fontWeight: 400 }}>(optional)</span>
            </span>
            <textarea
              value={targetingJson}
              onChange={(e) => setTargetingJson(e.target.value)}
              placeholder={'{\n  "tenant_ids": ["t1"],\n  "user_ids": ["u1"]\n}'}
              rows={4}
              style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "monospace", resize: "vertical" }}
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Shape: {"{ tenant_ids?: string[], user_ids?: string[] }"}. Leave blank to rely on rollout % only.</span>
          </label>

          {error && (
            <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "10px 14px", color: "#ef4444", fontSize: 13 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
            <button
              onClick={onClose}
              style={{ padding: "10px 18px", borderRadius: 8, border: "1px solid var(--border)", background: "none", color: "var(--text)", cursor: "pointer", fontSize: 14, minHeight: 44 }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !key.trim()}
              style={{
                padding: "10px 18px", borderRadius: 8, border: "none",
                background: "var(--accent)", color: "#fff", cursor: "pointer",
                fontSize: 14, fontWeight: 600, minHeight: 44, opacity: saving || !key.trim() ? 0.6 : 1,
              }}
            >
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create flag"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface HistoryPanelProps {
  flag: FeatureFlag;
  onClose: () => void;
}

function HistoryPanel({ flag, onClose }: HistoryPanelProps) {
  const { data, loading, error } = useAuthApi<{ history: FlagHistory[] }>(
    `/api/feature-flags/${flag.id}/history`,
    0,
  );

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: "var(--surface)", borderRadius: 12, padding: 28,
        width: "min(600px, 96vw)", maxHeight: "80vh", display: "flex", flexDirection: "column",
        border: "1px solid var(--border)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", margin: 0 }}>
            Change history: <code style={{ fontSize: 15 }}>{flag.key}</code>
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, minHeight: 44, minWidth: 44, color: "var(--text-muted)" }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading && <p style={{ color: "var(--text-muted)", fontSize: 14, textAlign: "center", padding: 24 }}>Loading…</p>}
          {error && <p style={{ color: "#ef4444", fontSize: 13, padding: 12 }}>Error: {error}</p>}
          {!loading && !error && data && data.history.length === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: 14, textAlign: "center", padding: 24 }}>No history yet.</p>
          )}
          {!loading && data && data.history.map((h) => (
            <div key={h.id} style={{ borderBottom: "1px solid var(--border)", padding: "12px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", textTransform: "capitalize" }}>
                  {h.note ?? "modified"}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {fmtDate(h.ts)} · {h.changedBy}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface FlagRowProps {
  flag: FeatureFlag;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onEdit: (flag: FeatureFlag) => void;
  onHistory: (flag: FeatureFlag) => void;
  onDelete: (id: string) => void;
  toggling: string | null;
}

function FlagRow({ flag, onToggle, onEdit, onHistory, onDelete, toggling }: FlagRowProps) {
  const stale = isStale(flag);
  const isToggling = toggling === flag.id;

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px",
      background: "var(--surface)", marginBottom: 10,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <code style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{flag.key}</code>
            {flag.label && <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{flag.label}</span>}
            {stale && (
              <span style={{
                fontSize: 11, padding: "2px 8px", borderRadius: 100,
                background: "rgba(234,179,8,0.15)", color: "#ca8a04",
                border: "1px solid rgba(234,179,8,0.3)", fontWeight: 600,
              }}>
                STALE — fully rolled out
              </span>
            )}
          </div>
          {flag.description && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0", lineHeight: 1.5 }}>
              {flag.description}
            </p>
          )}
          <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Rollout: <strong style={{ color: "var(--text)" }}>{flag.rolloutPercentage}%</strong>
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Updated: <strong style={{ color: "var(--text)" }}>{fmtAge(flag.updatedAt)}</strong>
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {/* Toggle */}
          <button
            onClick={() => onToggle(flag.id, !flag.enabled)}
            disabled={isToggling}
            title={flag.enabled ? "Disable flag" : "Enable flag"}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)",
              background: flag.enabled ? "rgba(34,197,94,0.12)" : "var(--bg)",
              color: flag.enabled ? "#16a34a" : "var(--text-muted)",
              cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 44, minWidth: 72,
              opacity: isToggling ? 0.6 : 1, transition: "background 0.15s",
            }}
          >
            {isToggling ? "…" : flag.enabled ? "On" : "Off"}
          </button>

          {/* Edit */}
          <button
            onClick={() => onEdit(flag)}
            title="Edit flag"
            style={{
              padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)",
              background: "none", color: "var(--text-muted)", cursor: "pointer",
              fontSize: 13, minHeight: 44,
            }}
          >
            Edit
          </button>

          {/* History */}
          <button
            onClick={() => onHistory(flag)}
            title="View change history"
            style={{
              padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)",
              background: "none", color: "var(--text-muted)", cursor: "pointer", minHeight: 44,
            }}
          >
            <History size={15} />
          </button>

          {/* Delete */}
          <button
            onClick={() => onDelete(flag.id)}
            title="Delete flag"
            style={{
              padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)",
              background: "rgba(239,68,68,0.07)", color: "#ef4444", cursor: "pointer", minHeight: 44,
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function FeatureFlagsPage() {
  const { data, loading, error, refresh } = useAuthApi<{ flags: FeatureFlag[] }>("/api/feature-flags", 30_000);
  const [showCreate, setShowCreate] = useState(false);
  const [editFlag, setEditFlag] = useState<FeatureFlag | null>(null);
  const [historyFlag, setHistoryFlag] = useState<FeatureFlag | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const flags = data?.flags ?? [];

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    setToggling(id);
    setActionError(null);
    try {
      const res = await authFetch(`/api/feature-flags/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(null);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (id: string) => {
    setActionError(null);
    try {
      const res = await authFetch(`/api/feature-flags/${id}`, { method: "DELETE" });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDeleteConfirmId(null);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  const staleCount = flags.filter(isStale).length;

  return (
    <div className="dash-page">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Flag size={22} style={{ color: "var(--accent)" }} />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>Feature Flags</h1>
          {flags.length > 0 && (
            <span style={{
              fontSize: 12, padding: "2px 8px", borderRadius: 100,
              background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-muted)",
            }}>
              {flags.length} flag{flags.length !== 1 ? "s" : ""}
            </span>
          )}
          {staleCount > 0 && (
            <span style={{
              fontSize: 12, padding: "2px 8px", borderRadius: 100,
              background: "rgba(234,179,8,0.15)", border: "1px solid rgba(234,179,8,0.3)", color: "#ca8a04",
            }}>
              {staleCount} stale
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={refresh}
            title="Refresh"
            style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "none", color: "var(--text-muted)", cursor: "pointer", minHeight: 44 }}
          >
            <RefreshCw size={15} />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "9px 16px", borderRadius: 8, border: "none",
              background: "var(--accent)", color: "#fff", cursor: "pointer",
              fontSize: 14, fontWeight: 600, minHeight: 44,
            }}
          >
            <Plus size={15} /> New flag
          </button>
        </div>
      </div>

      {actionError && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "10px 14px", color: "#ef4444", fontSize: 13, marginTop: 12 }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 10, background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 13 }}>Dismiss</button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: 48, color: "var(--text-muted)", fontSize: 14 }}>
          Loading feature flags…
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 10, padding: 20, textAlign: "center", marginTop: 12 }}>
          <p style={{ color: "#ef4444", margin: "0 0 12px", fontSize: 14 }}>Failed to load feature flags: {error}</p>
          <button
            onClick={refresh}
            style={{ padding: "9px 18px", borderRadius: 8, border: "1px solid var(--border)", background: "none", color: "var(--text)", cursor: "pointer", fontSize: 13, minHeight: 44 }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && flags.length === 0 && (
        <div style={{ textAlign: "center", padding: "60px 24px", border: "1px dashed var(--border)", borderRadius: 12, marginTop: 12 }}>
          <Flag size={36} style={{ color: "var(--text-muted)", marginBottom: 12, opacity: 0.4 }} />
          <p style={{ color: "var(--text-muted)", fontSize: 15, margin: "0 0 16px" }}>
            No feature flags yet — create one to gate a feature.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "10px 18px", borderRadius: 8, border: "none",
              background: "var(--accent)", color: "#fff", cursor: "pointer",
              fontSize: 14, fontWeight: 600, minHeight: 44,
            }}
          >
            <Plus size={15} /> Create your first flag
          </button>
        </div>
      )}

      {/* Flag list */}
      {!loading && !error && flags.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {flags.map((flag) => (
            <div key={flag.id}>
              {deleteConfirmId === flag.id ? (
                <div style={{
                  border: "1px solid rgba(239,68,68,0.4)", borderRadius: 10, padding: "14px 16px",
                  background: "rgba(239,68,68,0.06)", marginBottom: 10,
                }}>
                  <p style={{ color: "var(--text)", fontSize: 14, margin: "0 0 12px" }}>
                    Delete <code style={{ fontWeight: 700 }}>{flag.key}</code>? This cannot be undone.
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => handleDelete(flag.id)}
                      style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: "#ef4444", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 44 }}
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(null)}
                      style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid var(--border)", background: "none", color: "var(--text)", cursor: "pointer", fontSize: 13, minHeight: 44 }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <FlagRow
                  flag={flag}
                  onToggle={handleToggle}
                  onEdit={(f) => setEditFlag(f)}
                  onHistory={(f) => setHistoryFlag(f)}
                  onDelete={(id) => setDeleteConfirmId(id)}
                  toggling={toggling}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {showCreate && (
        <FlagModal onClose={() => setShowCreate(false)} onSaved={refresh} />
      )}
      {editFlag && (
        <FlagModal initial={editFlag} onClose={() => setEditFlag(null)} onSaved={refresh} />
      )}
      {historyFlag && (
        <HistoryPanel flag={historyFlag} onClose={() => setHistoryFlag(null)} />
      )}
    </div>
  );
}
