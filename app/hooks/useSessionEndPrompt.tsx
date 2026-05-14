import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { authFetch } from "../lib/authFetch";
import type { ReactNode } from "react";

// Re-export types for backward compatibility with any callers
export type { VaultLogDraft, VaultLogDismissReason } from "../components/AgentVaultLogModal";

type AgentId = "claude" | "codex" | "opencode" | "gemini";

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

// The vault-log dialog has been removed. All agent sessions are now logged
// automatically and silently once they reach the minimum message threshold.
// The manual AgentVaultLogButton remains available in agent topbars.
export function useSessionEndPrompt({
  agent,
  sessionId,
  title,
  directory,
  messages,
}: SessionEndPromptProps) {
  const [location] = useLocation();
  const askedRef = useRef<Set<string>>(new Set());
  const latestRef = useRef({ agent, sessionId, title, directory, messages });
  const prevLocationRef = useRef(location);

  useEffect(() => {
    latestRef.current = { agent, sessionId, title, directory, messages };
  }, [agent, sessionId, title, directory, messages]);

  const silentLog = useCallback((reason: SessionEndReason) => {
    const current = latestRef.current;
    if (!current.sessionId || current.messages.length < MIN_LOGGABLE_MESSAGES) return;
    if (askedRef.current.has(current.sessionId)) return;
    askedRef.current.add(current.sessionId);

    const draft = makeDraft(current.agent, current.title, current.directory, current.messages, reason);
    const files = draft.filePaths.trim();

    authFetch("/api/agents/vault-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: current.agent,
        sessionId: current.sessionId,
        title: current.title || `${current.agent} session`,
        directory: current.directory,
        messageCount: current.messages.length,
        goal: draft.title,
        changed: files ? `${draft.body}\n\nEdited files:\n${files}` : draft.body,
        evidence: `${current.agent} session auto-logged on ${reason}.`,
        next: draft.next,
        includeVault: true,
        includeProject: false,
        includeMasterPlan: false,
      }),
    }).catch(() => {}); // fire-and-forget — errors are silent
  }, []);

  // Passive location-change log — no navigation blocking
  useEffect(() => {
    if (location !== prevLocationRef.current) {
      prevLocationRef.current = location;
      silentLog("navigate-away");
    }
  }, [location, silentLog]);

  // Log on unmount (component removed from tree)
  useEffect(() => {
    return () => { silentLog("navigate-away"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const triggerSessionEnd = useCallback((reason: SessionEndReason, after?: () => void) => {
    silentLog(reason);
    if (after) requestAnimationFrame(after);
    return false; // Never blocks — caller should always proceed
  }, [silentLog]);

  return {
    triggerSessionEnd,
    sessionEndPromptModal: null as ReactNode,
  };
}

// ── Draft builders (retained for log content generation) ──────────────────────

function makeDraft(
  agent: AgentId,
  title: string | undefined,
  directory: string | undefined,
  messages: SessionEndMessage[],
  reason: SessionEndReason,
) {
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
    includeProject: false,
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
