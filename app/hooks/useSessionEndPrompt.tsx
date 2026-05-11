import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { AgentVaultLogModal, type VaultLogDraft, type VaultLogDismissReason } from "../components/AgentVaultLogModal";
import { authFetch } from "../lib/authFetch";

type AgentId = "claude" | "codex" | "opencode";

export type SessionEndMessage = {
  role: string;
  content?: string;
  toolText?: string;
  filePaths?: string[];
};

type SessionEndPromptProps = {
  agent: AgentId;
  sessionId?: string | null;
  title?: string;
  directory?: string;
  messages: SessionEndMessage[];
};

type SessionEndReason = "new-session" | "clear-session" | "end-session" | "navigate-away";

const MIN_LOGGABLE_MESSAGES = 6;

export function useSessionEndPrompt({
  agent,
  sessionId,
  title,
  directory,
  messages,
}: SessionEndPromptProps) {
  const [location, setLocation] = useLocation();
  const [draft, setDraft] = useState<VaultLogDraft | null>(null);
  const askedRef = useRef<Set<string>>(new Set());
  const afterRef = useRef<(() => void) | null>(null);
  const latestRef = useRef({ agent, sessionId, title, directory, messages });

  useEffect(() => {
    latestRef.current = { agent, sessionId, title, directory, messages };
  }, [agent, sessionId, title, directory, messages]);

  const triggerSessionEnd = useCallback((reason: SessionEndReason, after?: () => void) => {
    const current = latestRef.current;
    if (!current.sessionId || current.messages.length < MIN_LOGGABLE_MESSAGES) return false;
    if (askedRef.current.has(current.sessionId)) return false;

    askedRef.current.add(current.sessionId);
    afterRef.current = after ?? null;
    setDraft(makeDraft(current.agent, current.title, current.directory, current.messages, reason));
    return true;
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const next = `${url.pathname}${url.search}${url.hash}`;
      if (next === location) return;
      const prompted = triggerSessionEnd("navigate-away", () => setLocation(next));
      if (prompted) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      triggerSessionEnd("navigate-away");
    };
  }, [location, setLocation, triggerSessionEnd]);

  const submit = useCallback(async (nextDraft: VaultLogDraft) => {
    const current = latestRef.current;
    const sessionTitle = current.title || `${current.agent} session`;
    const files = nextDraft.filePaths.trim();
    const evidence = [
      `Dashboard ${current.agent} session ${current.sessionId ?? "unknown-session"}; end-of-session log prompt.`,
      files ? `Edited files: ${files.replace(/\n+/g, ", ")}` : "",
    ].filter(Boolean).join(" ");

    const res = await authFetch("/api/agents/vault-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: current.agent,
        sessionId: current.sessionId,
        title: sessionTitle,
        directory: current.directory,
        messageCount: current.messages.length,
        goal: nextDraft.title,
        changed: files ? `${nextDraft.body}\n\nEdited files:\n${files}` : nextDraft.body,
        evidence,
        next: nextDraft.next,
        includeVault: nextDraft.includeVault,
        includeProject: nextDraft.includeProject,
        includeMasterPlan: nextDraft.includeMasterPlan,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json() as { written: string[] };
    return json.written;
  }, []);

  const dismiss = useCallback((_: VaultLogDismissReason) => {
    setDraft(null);
    const after = afterRef.current;
    afterRef.current = null;
    if (after) requestAnimationFrame(after);
  }, []);

  const modal = useMemo(() => draft ? (
    <AgentVaultLogModal
      heading="Log this run?"
      message="This session has enough context to preserve. Review the generated summary, choose targets, or dismiss without writing anything."
      initial={draft}
      confirmLabel="Confirm"
      showDontAsk
      onConfirm={submit}
      onDismiss={dismiss}
    />
  ) : null, [dismiss, draft, submit]);

  return { triggerSessionEnd, sessionEndPromptModal: modal };
}

function makeDraft(
  agent: AgentId,
  title: string | undefined,
  directory: string | undefined,
  messages: SessionEndMessage[],
  reason: SessionEndReason,
): VaultLogDraft {
  const firstUser = messages.find((m) => m.role === "user" && textOf(m)) ?? messages[0];
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && textOf(m));
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m));
  const filePaths = extractFilePaths(messages).join("\n");
  const sessionTitle = truncate(cleanText(textOf(firstUser) || title || `${agent} session`), 96);
  const body = [
    lastUser ? `Last user prompt: ${condense(textOf(lastUser), 420)}` : "",
    lastAssistant ? `Last assistant response: ${condense(textOf(lastAssistant), 700)}` : "",
  ].filter(Boolean).join("\n\n") || `Session in ${directory || "unknown workspace"} ended via ${reason.replace(/-/g, " ")}.`;

  return {
    title: sessionTitle,
    body,
    filePaths,
    next: "Continue from the relevant dashboard or stack plan.",
    includeVault: true,
    includeProject: true,
    includeMasterPlan: false,
  };
}

function textOf(message?: SessionEndMessage): string {
  if (!message) return "";
  return [message.content, message.toolText].filter(Boolean).join("\n");
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function condense(text: string, limit: number): string {
  return truncate(cleanText(text), limit);
}

function extractFilePaths(messages: SessionEndMessage[]): string[] {
  const found = new Set<string>();
  const add = (path: string) => {
    const cleaned = path.replace(/[),.;\]}]+$/g, "");
    if (cleaned.length > 2 && !cleaned.includes("://")) found.add(cleaned);
  };

  for (const message of messages) {
    for (const path of message.filePaths ?? []) add(path);
    const text = textOf(message);
    for (const match of text.matchAll(/(?:^|[\s"'`(])((?:\/[A-Za-z0-9._-]+){2,})/g)) add(match[1]);
    for (const match of text.matchAll(/\b((?:app|server|config|scripts|src|lib|tests?)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)\b/g)) add(match[1]);
  }

  return [...found].slice(0, 24);
}
