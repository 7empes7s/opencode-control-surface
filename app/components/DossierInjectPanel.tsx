import { useState } from "react";
import type { DossierArtifacts } from "../../server/api/types";

interface DossierInjectPanelProps {
  dossier: DossierArtifacts;
  onInject: (notes: string, stage: string | null, requeue: boolean) => Promise<void>;
}

export function DossierInjectPanel({ dossier, onInject }: DossierInjectPanelProps) {
  const [notes, setNotes] = useState("");
  const [stage, setStage] = useState("");
  const [requeue, setRequeue] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setSuccess(false); setError("");
    try {
      await onInject(notes, stage || null, requeue);
      setSuccess(true);
      setNotes("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to inject notes");
    } finally {
      setLoading(false);
    }
  };

  const SEL: React.CSSProperties = {
    fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)",
    border: "1px solid var(--border)", color: "var(--text)", padding: "6px 9px", borderRadius: 3,
  };

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      {/* Form */}
      <div style={{ flex: 1, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4 }}>
        <div style={{ padding: "7px 14px", borderBottom: "1px solid var(--border)", fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Inject Notes</div>
        <form onSubmit={handleSubmit} style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Notes</label>
            <textarea
              className="form-input"
              rows={6}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional context or instructions for the AI…"
              required
              style={{ resize: "vertical" }}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Re-queue at stage (optional)</label>
            <select style={SEL} value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">Don't re-queue</option>
              <option value="research">Research</option>
              <option value="write">Write</option>
              <option value="verify">Verify</option>
              <option value="publish-prep">Publish Prep</option>
            </select>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", cursor: "pointer" }}>
            <input type="checkbox" checked={requeue} onChange={(e) => setRequeue(e.target.checked)} />
            Re-queue automatically after injecting
          </label>

          <div className="action-bar">
            <button className="btn btn-primary" type="submit" disabled={loading || !notes.trim()}>
              {loading ? "Injecting…" : "Inject Notes"}
            </button>
            {success && <span className="action-feedback ok">Injected successfully</span>}
            {error && <span className="action-feedback err">{error}</span>}
          </div>
        </form>
      </div>

      {/* Existing notes */}
      <div style={{ flex: 1, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4 }}>
        <div style={{ padding: "7px 14px", borderBottom: "1px solid var(--border)", fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Existing Notes</div>
        <pre style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", padding: "14px 16px", whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 400, margin: 0 }}>
          {dossier.notesContent || "No notes yet."}
        </pre>
      </div>
    </div>
  );
}
