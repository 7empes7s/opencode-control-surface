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
    setLoading(true);
    setSuccess(false);
    setError("");
    
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

  return (
    <div className="grid grid-cols-2 gap-6">
      <div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Notes <span className="form-tooltip">ⓘ<span className="tooltip-text">Enter notes to inject into the dossier. These will be appended to the existing notes.</span></span></label>
            <textarea 
              className="form-input" 
              rows={6}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Enter notes to inject into the dossier... (e.g., 'Focus on technical accuracy in the verification stage')"
              required
            />
            <div className="form-help">Provide additional context or instructions for the AI to consider when processing this dossier.</div>
          </div>
          
          <div className="form-group">
            <label>Stage to re-queue (optional) <span className="form-tooltip">ⓘ<span className="tooltip-text">Select a stage to re-queue the dossier. Leave blank to keep current position.</span></span></label>
            <select 
              className="form-select"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
            >
              <option value="">Don't re-queue</option>
              <option value="research">Research</option>
              <option value="write">Write</option>
              <option value="verify">Verify</option>
              <option value="publish-prep">Publish Prep</option>
            </select>
            <div className="form-help">Choose a pipeline stage to restart processing from, or leave blank to continue from current position.</div>
          </div>
          
          <div className="form-group">
            <label className="form-checkbox">
              <input
                type="checkbox"
                checked={requeue}
                onChange={(e) => setRequeue(e.target.checked)}
              />
              <span>Re-queue after injecting <span className="form-tooltip">ⓘ<span className="tooltip-text">Automatically re-queue the dossier after injecting these notes.</span></span></span>
            </label>
            <div className="form-help">Enable this to automatically restart the dossier processing after injecting your notes.</div>
          </div>
          
          <div className="action-bar">
            <button 
              className="btn btn-primary" 
              type="submit"
              disabled={loading || !notes.trim()}
            >
              {loading ? "Injecting Notes..." : "Inject Notes Into Dossier"}
            </button>
            
            {success && <span className="action-feedback ok">Notes injected successfully!</span>}
            {error && <span className="action-feedback err">{error}</span>}
          </div>
        </form>
      </div>
      
      <div>
        <h3 className="section-title">Existing Notes</h3>
        <pre className="code-block">{dossier.notesContent}</pre>
      </div>
    </div>
  );
}