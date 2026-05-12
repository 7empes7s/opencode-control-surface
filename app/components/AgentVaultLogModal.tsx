import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, BookOpen, CheckCircle2, Loader2 } from "lucide-react";

export type VaultLogDraft = {
  title: string;
  body: string;
  filePaths: string;
  next: string;
  includeVault: boolean;
  includeProject: boolean;
  includeMasterPlan: boolean;
};

export type VaultLogDismissReason = "dismiss" | "dont-ask" | "confirmed";

export function AgentVaultLogModal({
  heading = "Log to AI Vault",
  message = "Review the generated entry before writing it to the selected targets.",
  initial,
  confirmLabel = "Write log",
  showDontAsk = false,
  onConfirm,
  onDismiss,
}: {
  heading?: string;
  message?: string;
  initial: VaultLogDraft;
  confirmLabel?: string;
  showDontAsk?: boolean;
  onConfirm: (draft: VaultLogDraft) => Promise<string[]>;
  onDismiss: (reason: VaultLogDismissReason) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);

  useEffect(() => {
    setDraft(initial);
    setError(null);
    setDone(null);
  }, [initial]);

  const update = (patch: Partial<VaultLogDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const written = await onConfirm(draft);
      setDone(written);
      onDismiss("confirmed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const noTarget = !draft.includeVault && !draft.includeProject && !draft.includeMasterPlan;

  const modal = (
    <div className="modal-overlay" onClick={() => !busy && onDismiss("dismiss")}>
      <div className="modal-box oc-vault-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{heading}</div>
        <div className="modal-message">{message}</div>

        <VaultField label="Title" value={draft.title} onChange={(title) => update({ title })} />
        <VaultField label="Body" value={draft.body} onChange={(body) => update({ body })} rows={4} />
        <VaultField
          label="File paths edited"
          value={draft.filePaths}
          onChange={(filePaths) => update({ filePaths })}
          placeholder="One path per line, or leave blank."
        />
        <VaultField label="Next" value={draft.next} onChange={(next) => update({ next })} />

        <div className="oc-vault-targets" aria-label="Log targets">
          <VaultCheck
            label="Daily vault"
            checked={draft.includeVault}
            onChange={(includeVault) => update({ includeVault })}
          />
          <VaultCheck
            label="Dashboard project note"
            checked={draft.includeProject}
            onChange={(includeProject) => update({ includeProject })}
          />
          <VaultCheck
            label="Master-plan progress entry"
            checked={draft.includeMasterPlan}
            onChange={(includeMasterPlan) => update({ includeMasterPlan })}
          />
        </div>

        {error && (
          <div className="modal-error oc-vault-status">
            <AlertTriangle size={13} /> {error}
          </div>
        )}
        {done && (
          <div className="oc-vault-success">
            <CheckCircle2 size={13} /> wrote {done.length} file{done.length === 1 ? "" : "s"}
          </div>
        )}

        <div className="modal-actions">
          {showDontAsk && (
            <button className="btn btn-ghost" onClick={() => onDismiss("dont-ask")} disabled={busy}>
              Don't ask again this session
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => onDismiss("dismiss")} disabled={busy}>
            Dismiss
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !draft.title.trim() || noTarget}>
            {busy ? <Loader2 size={13} className="oc-spin" /> : <BookOpen size={13} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function VaultField({
  label,
  value,
  onChange,
  placeholder,
  rows = 2,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div className="modal-input-row">
      <label className="modal-input-label">{label}</label>
      <textarea
        className="modal-input oc-vault-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
      />
    </div>
  );
}

function VaultCheck({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="oc-vault-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
