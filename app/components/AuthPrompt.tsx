import { useEffect, useState } from "react";
import { ConfirmModal } from "./ConfirmModal";

export function AuthPrompt() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.reason) {
        setOpen(true);
        setError(null);
      }
    };
    window.addEventListener("auth-required", handler);
    return () => window.removeEventListener("auth-required", handler);
  }, []);

  async function handleConfirm(token: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setOpen(false);
        window.dispatchEvent(new CustomEvent("auth-response", { detail: { success: true } }));
      } else {
        const text = await res.text();
        setError(text || "Invalid token");
        window.dispatchEvent(new CustomEvent("auth-response", { detail: { success: false } }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      window.dispatchEvent(new CustomEvent("auth-response", { detail: { success: false } }));
    } finally {
      setLoading(false);
    }
  }

  function handleCancel() {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("auth-response", { detail: { success: false } }));
  }

  if (!open) return null;

  return (
    <ConfirmModal
      title="Authentication Required"
      message="Your session has expired or this action requires operator authentication."
      inputLabel="Operator token"
      inputPlaceholder="Enter token…"
      confirmLabel="Authenticate"
      loading={loading}
      error={error}
      onConfirm={(val) => handleConfirm(val || "")}
      onCancel={handleCancel}
    />
  );
}
