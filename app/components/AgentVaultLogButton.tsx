import { useMemo, useState } from "react";
import { BookOpen } from "lucide-react";
import { AgentVaultLogModal, type VaultLogDraft } from "./AgentVaultLogModal";
import { authFetch } from "../lib/authFetch";

type AgentId = "claude" | "codex" | "opencode" | "gemini";

export function AgentVaultLogButton({
  agent,
  sessionId,
  title,
  directory,
  messageCount,
  disabled,
}: {
  agent: AgentId;
  sessionId: string;
  title: string;
  directory: string;
  messageCount: number;
  disabled?: boolean;
}) {
  const defaults = useMemo<VaultLogDraft>(() => ({
    title: `Log ${agent} session: ${title || "Untitled session"}`,
    body: `Agent session in ${directory}; ${messageCount} messages.`,
    filePaths: "",
    next: "Continue from the relevant dashboard or stack plan.",
    includeVault: true,
    includeProject: true,
    includeMasterPlan: true,
  }), [agent, directory, messageCount, sessionId, title]);

  const [open, setOpen] = useState(false);

  const submit = async (draft: VaultLogDraft) => {
    const evidence = [
      `Dashboard ${agent} session ${sessionId}; manual browser vault log.`,
      draft.filePaths.trim() ? `Edited files: ${draft.filePaths.trim().replace(/\n+/g, ", ")}` : "",
    ].filter(Boolean).join(" ");
    const res = await authFetch("/api/agents/vault-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent,
        sessionId,
        title,
        directory,
        messageCount,
        goal: draft.title,
        changed: draft.filePaths.trim()
          ? `${draft.body}\n\nEdited files:\n${draft.filePaths.trim()}`
          : draft.body,
        evidence,
        next: draft.next,
        includeVault: draft.includeVault,
        includeProject: draft.includeProject,
        includeMasterPlan: draft.includeMasterPlan,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json() as { written: string[] };
    return json.written;
  };

  return (
    <>
      <button
        type="button"
        className="oc-model-btn oc-vault-btn"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="Log this session to AI Vault"
      >
        <BookOpen size={13} strokeWidth={1.75} />
        <span className="oc-model-label">vault</span>
      </button>

      {open && (
        <AgentVaultLogModal
          initial={defaults}
          message="Review the generated entry before writing it to the daily vault, dashboard project note, and optional master plan."
          onConfirm={submit}
          onDismiss={() => setOpen(false)}
        />
      )}
    </>
  );
}
