import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  message?: string;
  inputLabel?: string;
  inputPlaceholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  error?: string | null;
  onConfirm: (inputValue?: string) => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title, message, inputLabel, inputPlaceholder,
  confirmLabel = "Confirm", danger = false,
  loading = false, error,
  onConfirm, onCancel,
}: Props) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputLabel) inputRef.current?.focus();
  }, [inputLabel]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const submit = () => {
    if (inputLabel && !inputValue.trim()) return;
    onConfirm(inputLabel ? inputValue.trim() : undefined);
  };

  const modal = (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        {message && <div className="modal-message">{message}</div>}
        {inputLabel && (
          <div className="modal-input-row">
            <label className="modal-input-label">{inputLabel}</label>
            <input
              ref={inputRef}
              className="modal-input"
              placeholder={inputPlaceholder}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              disabled={loading}
            />
          </div>
        )}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={submit}
            disabled={loading || (!!inputLabel && !inputValue.trim())}
          >
            {loading ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
