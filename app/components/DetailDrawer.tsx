import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type DetailDrawerProps = {
  open: boolean;
  title: React.ReactNode;
  kicker?: React.ReactNode;
  summary?: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  ariaLabel?: string;
};

export function DetailDrawer({
  open,
  title,
  kicker,
  summary,
  children,
  onClose,
  ariaLabel,
}: DetailDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="evidence-drawer-overlay detail-drawer-overlay" onClick={onClose}>
      <aside
        className="evidence-drawer detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : "Detail drawer")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="evidence-drawer-head">
          <div>
            {kicker && <div className="evidence-drawer-kicker">{kicker}</div>}
            <div className="evidence-drawer-title">{title}</div>
          </div>
          <button ref={closeRef} className="drawer-close" onClick={onClose} aria-label="Close detail drawer">
            <X size={18} strokeWidth={1.9} />
          </button>
        </div>
        {summary && <div className="evidence-drawer-summary">{summary}</div>}
        <div className="detail-drawer-body">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
