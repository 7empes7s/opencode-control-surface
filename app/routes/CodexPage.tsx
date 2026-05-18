import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  Plus, Trash2, Menu, X,
  ChevronDown, FolderOpen, FileText, Cpu, Loader2,
  Wrench, MessageSquare, Brain,
} from "lucide-react";
import { AgentDiscoveryStrip } from "../components/AgentDiscoveryStrip";
import { AgentComposer } from "../components/AgentComposer";
import { AgentVaultLogButton } from "../components/AgentVaultLogButton";
import { AgentBuilderHandoffButton } from "../components/AgentBuilderHandoffButton";
import { TranscriptControls, type ActionFilter, type TranscriptMode } from "../components/TranscriptControls";
import { ConfirmModal } from "../components/ConfirmModal";
import { useSessionEndPrompt } from "../hooks/useSessionEndPrompt";
import { authFetch } from "../lib/authFetch";

const PRESET_DIRS = [
  "/opt/newsbites",
  "/opt/mimoun",
  "/opt/paperclip",
  "/opt/opencode-control-surface",
  "/opt",
  "/root",
];

type CodexSessionMeta = {
  id: string;
  title: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  codexSessionId: string | null;
  running?: boolean;
  runStartedAt?: number | null;
};

type CodexMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  items?: StreamItem[];
};

type StreamItem = {
  id?: string;
  type: string; // "agent_message" | "reasoning" | "command_execution" | other
  text?: string;
  [key: string]: unknown;
};

type CodexSession = CodexSessionMeta & { messages: CodexMessage[] };

function NewCodexModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: CodexSession) => void }) {
  const [dir, setDir] = useState("/opt");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await authFetch("/api/codex/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: dir.trim(), title: title.trim() || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json() as { session: CodexSession };
      onCreated({ ...json.session, messages: [] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box oc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">New Codex session</div>
        <div className="modal-message">Working directory shapes everything Codex sees.</div>

        <div className="modal-input-row">
          <label className="modal-input-label">Directory</label>
          <input
            className="modal-input"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="/opt/newsbites"
            autoFocus
          />
        </div>
        <div className="modal-input-row">
          <label className="modal-input-label">Title (optional)</label>
          <input
            className="modal-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Investigate doctor errors"
          />
        </div>

        <div className="oc-dir-group">
          <div className="oc-dir-group-label">Presets</div>
          <div className="oc-dir-chips">
            {PRESET_DIRS.map((d) => (
              <button key={d} type="button" className="oc-dir-chip" onClick={() => setDir(d)}>
                <FolderOpen size={11} /> {d}
              </button>
            ))}
          </div>
        </div>

        {err && <div className="modal-error">{err}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CodexPage() {
  const [sessions, setSessions] = useState<CodexSessionMeta[]>([]);
  const [active, setActive] = useState<CodexSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveItems, setLiveItems] = useState<StreamItem[]>([]);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("all");
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadList = async () => {
    try {
      const res = await authFetch("/api/codex/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { sessions: CodexSessionMeta[] };
      const list = Array.isArray(json.sessions) ? json.sessions : [];
      setSessions(list);
      return list;
    } catch (e) {
      setSessions([]);
      setError(e instanceof Error ? e.message : String(e));
      return [] as CodexSessionMeta[];
    }
  };

  useEffect(() => {
    loadList().then((list) => {
      setLoading(false);
      if (list.length > 0) selectSession(list[0].id);
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages.length, liveItems.length]);

  useEffect(() => {
    if (!active?.id || !active.running) return;
    setSending(true);
    const poll = async () => {
      try {
        const res = await authFetch(`/api/codex/sessions/${active.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as { session: CodexSession };
        const next = {
          ...json.session,
          messages: Array.isArray(json.session.messages) ? json.session.messages : [],
        };
        setActive(next);
        if (!next.running) {
          setSending(false);
          setLiveItems([]);
          loadList();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    const timer = window.setInterval(poll, 5000);
    poll();
    return () => window.clearInterval(timer);
  }, [active?.id, active?.running]);

  const selectSession = async (id: string) => {
    setError(null);
    try {
      const res = await authFetch(`/api/codex/sessions/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { session: CodexSession };
      setActive({ ...json.session, messages: Array.isArray(json.session.messages) ? json.session.messages : [] });
      setDrawerOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteSession = async (id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    setDeleteTarget({ id, title: session.title });
  };

  const confirmDeleteSession = async () => {
    if (!deleteTarget) return;
    await authFetch(`/api/codex/sessions/${deleteTarget.id}`, { method: "DELETE" });
    if (active?.id === deleteTarget.id) setActive(null);
    setDeleteTarget(null);
    loadList();
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !active || sending) return;
    setSending(true);
    setError(null);
    setLiveItems([]);

    const userMsg: CodexMessage = {
      id: `tmp_${Date.now()}`,
      role: "user",
      content: text,
      ts: Date.now(),
    };
    setActive({ ...active, messages: [...active.messages, userMsg] });
    setInput("");

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await authFetch(`/api/codex/sessions/${active.id}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let streamErr: string | null = null;

      const handle = (eventName: string, data: string) => {
        let payload: unknown;
        try { payload = JSON.parse(data); } catch { return; }
        if (eventName === "item") {
          const item = (payload as { item: StreamItem }).item;
          setLiveItems((prev) => [...prev, item]);
        } else if (eventName === "error") {
          streamErr = (payload as { error?: string }).error ?? "unknown error";
          setError(streamErr);
        } else if (eventName === "done") {
          // server has already persisted the assistant message; we'll refetch below
        }
      };

      // Parse SSE frames out of the stream
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = frame.split("\n");
          let eventName = "message";
          const dataLines: string[] = [];
          for (const ln of lines) {
            if (ln.startsWith("event:")) eventName = ln.slice(6).trim();
            else if (ln.startsWith("data:")) dataLines.push(ln.slice(5).trimStart());
          }
          if (dataLines.length > 0) handle(eventName, dataLines.join("\n"));
        }
      }

      // Stream done — refetch the persisted session so the live items become a real message
      const fetched = await authFetch(`/api/codex/sessions/${active.id}`);
      if (fetched.ok) {
        const json = await fetched.json() as { session: CodexSession };
        setActive({ ...json.session, messages: Array.isArray(json.session.messages) ? json.session.messages : [] });
      }
      loadList();
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      setLiveItems([]);
    }
  };

  const stop = async () => {
    if (active) {
      await authFetch(`/api/codex/sessions/${active.id}/stop`, { method: "POST" }).catch(() => null);
    }
    abortRef.current?.abort();
    setSending(false);
    setLiveItems([]);
    if (active) selectSession(active.id);
  };

  const orderedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const sessionEndMessages = useMemo(() => (
    active?.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolText: (m.items ?? [])
        .filter(isCodexActionItem)
        .map((item) => `${item.type} ${codexItemDetail(item)}`)
        .join("\n"),
    })) ?? []
  ), [active?.messages]);
  const { triggerSessionEnd, sessionEndPromptModal } = useSessionEndPrompt({
    agent: "codex",
    sessionId: active?.id,
    title: active?.title,
    directory: active?.directory,
    messages: sessionEndMessages,
  });

  const openNewSession = () => {
    setDrawerOpen(false);
    if (!triggerSessionEnd("new-session", () => setNewOpen(true))) setNewOpen(true);
  };

  const transcriptCounts = useMemo(() => {
    const items = [
      ...(active?.messages.flatMap((m) => m.items ?? []) ?? []),
      ...liveItems,
    ];
    return {
      messages: active?.messages.filter((m) => m.role !== "system").length ?? 0,
      actions: items.filter(isCodexActionItem).length,
      thoughts: items.filter(isCodexThoughtItem).length,
      errored: items.filter((item) => isCodexActionItem(item) && codexActionCategory(item) === "errored").length,
      edits: items.filter((item) => isCodexActionItem(item) && codexActionCategory(item) === "edits").length,
      deletes: items.filter((item) => isCodexActionItem(item) && codexActionCategory(item) === "deletes").length,
    };
  }, [active?.messages, liveItems]);

  return (
    <div className="oc-shell codex-shell">
      <header className="oc-topbar">
        <button className="oc-icon-btn" aria-label="Sessions" onClick={() => setDrawerOpen(true)}>
          <Menu size={18} strokeWidth={1.75} />
        </button>
        <div className="oc-topbar-titles">
          <div className="oc-topbar-title">{active?.title ?? "Codex"}</div>
          {active?.directory && <div className="oc-topbar-dir">{active.directory}</div>}
        </div>
        <span className="oc-model-btn" style={{ cursor: "default" }}>
          <Cpu size={13} strokeWidth={1.75} />
          <span className="oc-model-label">codex-cli</span>
          <ChevronDown size={12} style={{ opacity: 0.3 }} />
        </span>
        {active && (
          <AgentBuilderHandoffButton
            agent="codex"
            sessionId={active.id}
            title={active.title}
            directory={active.directory}
            messageCount={active.messages.length}
            messages={sessionEndMessages}
          />
        )}
        {active && (
          <AgentVaultLogButton
            agent="codex"
            sessionId={active.id}
            title={active.title}
            directory={active.directory}
            messageCount={active.messages.length}
          />
        )}
      </header>

      <aside className={`oc-sessions${drawerOpen ? " open" : ""}`}>
        <div className="oc-sessions-head">
          <span className="oc-sessions-title">Codex sessions</span>
          <button className="oc-icon-btn oc-drawer-close" aria-label="Close" onClick={() => setDrawerOpen(false)}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="oc-panel">
          <button className="oc-new-session" onClick={openNewSession}>
            <Plus size={14} strokeWidth={2} /> New session
          </button>
          <div className="oc-session-list">
            {loading && <div className="oc-session-empty">loading…</div>}
            {!loading && orderedSessions.length === 0 && (
              <div className="oc-session-empty">no sessions yet</div>
            )}
            {orderedSessions.map((s) => {
              const isActive = active?.id === s.id;
              return (
                <div
                  key={s.id}
                  className={`oc-session-item${isActive ? " active" : ""}`}
                  onClick={() => selectSession(s.id)}
                >
                  <div className="oc-session-content">
                    <div className="oc-session-title">{s.title}</div>
                    <div className="oc-session-meta">
                      <span className="oc-session-dir">{s.directory}</span>
                      <span>
                        {s.messageCount} msg · {formatDistanceToNowStrict(s.updatedAt, { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                  <button
                    className="oc-session-del"
                    aria-label="Delete"
                    onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </aside>
      {drawerOpen && <div className="oc-drawer-backdrop" onClick={() => setDrawerOpen(false)} />}

      <main className="oc-main">
        <AgentDiscoveryStrip agent="codex" onInsert={(t) => setInput((prev) => prev + t)} />
        {active && (
          <TranscriptControls
            mode={transcriptMode}
            actionFilter={actionFilter}
            counts={transcriptCounts}
            onModeChange={setTranscriptMode}
            onActionFilterChange={setActionFilter}
          />
        )}
        {!active ? (
          <div className="oc-empty">
            <FileText size={32} strokeWidth={1.25} />
            <div className="oc-empty-title">No session</div>
            <div className="oc-empty-sub">Open the menu to pick a session, or start a new one.</div>
            <button className="btn btn-primary" onClick={openNewSession}>
              <Plus size={14} /> New session
            </button>
            <div className="oc-codex-note">
              Codex runs as <code>codex exec</code> in the directory you pick. Runs continue
              on the server if this browser tab closes.
            </div>
          </div>
        ) : (
          <div className="oc-messages">
            {active.messages.length === 0 && (
              <div className="oc-thread-hint">Session ready — send a message to begin.</div>
            )}
            {active.messages.map((m) => {
              const isUser = m.role === "user";
              const isSystem = m.role === "system";
              if (isUser) {
                return (
                  <div key={m.id} className="msg-wrap">
                    <div className="msg-user"><div className="msg-user-bubble">{m.content}</div></div>
                  </div>
                );
              }
              const showContent = transcriptMode !== "actions" && m.content.trim().length > 0;
              const itemSource = showContent
                ? (m.items ?? []).filter((item) => !isCodexMessageItem(item))
                : (m.items ?? []);
              const visibleItems = codexVisibleItems(itemSource, transcriptMode, actionFilter);
              if (!showContent && visibleItems.length === 0 && !isSystem) return null;
              return (
                <div key={m.id} className="msg-wrap">
                  <div className="msg-assistant">
                    <div className={`msg-label model${isSystem ? " err" : ""}`}>
                      {isSystem ? "codex (error)" : "codex"}
                    </div>
                    {showContent && <div className="part-text">{m.content}</div>}
                    {visibleItems.map((item, idx) => (
                      <CodexLiveItem key={`${m.id}_${item.id ?? idx}`} item={item} />
                    ))}
                  </div>
                </div>
              );
            })}
            {sending && (
              <div className="msg-wrap">
                <div className="msg-assistant">
                  <div className="msg-label model">codex</div>
                  {active.running && liveItems.length === 0 ? (
                    <div className="part-text oc-codex-thinking">
                      <Loader2 size={12} className="oc-spin" /> running in background...
                    </div>
                  ) : codexVisibleItems(liveItems, transcriptMode, actionFilter).length === 0 ? (
                    <div className="part-text oc-codex-thinking">
                      <Loader2 size={12} className="oc-spin" /> {transcriptMode === "actions" ? "waiting for matching actions..." : "thinking..."}
                    </div>
                  ) : (
                    codexVisibleItems(liveItems, transcriptMode, actionFilter).map((it, idx) => <CodexLiveItem key={idx} item={it} />)
                  )}
                  {liveItems.length > 0 && (
                    <div className="oc-codex-thinking" style={{ marginTop: 6 }}>
                      <Loader2 size={11} className="oc-spin" /> running...
                    </div>
                  )}
                </div>
              </div>
            )}
            {active.messages.length > 0 && !sending && transcriptMode === "actions" && transcriptCounts.actions > 0 && active.messages.every((m) => m.role === "user" || codexVisibleItems(m.items ?? [], transcriptMode, actionFilter).length === 0) && (
              <div className="oc-thread-hint">No actions match this filter.</div>
            )}
            {error && <div className="loading-dim error" style={{ padding: "8px 20px" }}>{error}</div>}
            <div ref={bottomRef} />
          </div>
        )}

        {active && (
          <AgentComposer
            value={input}
            onChange={setInput}
            onSubmit={send}
            onStop={stop}
            running={sending}
            placeholder="Message Codex"
            agent="codex"
            workspace={active.directory}
          />
        )}
      </main>

      {newOpen && (
        <NewCodexModal
          onClose={() => setNewOpen(false)}
          onCreated={(s) => {
            setNewOpen(false);
            setActive(s);
            loadList();
          }}
        />
      )}
      {sessionEndPromptModal}
      {deleteTarget && (
        <ConfirmModal
          title="Delete Session"
          message={`Delete "${deleteTarget.title}"? Codex's own history file will not be deleted.`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDeleteSession}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

function isCodexThoughtItem(item: StreamItem): boolean {
  return item.type === "reasoning" || item.type === "reasoning_delta" || item.type.includes("reasoning");
}

function isCodexMessageItem(item: StreamItem): boolean {
  return item.type === "agent_message" || item.type === "message" || item.type === "assistant_message";
}

function isCodexActionItem(item: StreamItem): boolean {
  return !isCodexMessageItem(item) && !isCodexThoughtItem(item);
}

function codexItemDetail(item: StreamItem): string {
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === "id" || key === "type" || value === undefined || value === null) continue;
    rest[key] = value;
  }
  try {
    return Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : "";
  } catch {
    return "";
  }
}

function codexActionCategory(item: StreamItem): ActionFilter {
  const text = `${item.type} ${codexItemDetail(item)}`.toLowerCase();
  if (/\b(error|failed|exit code|non-zero|exception)\b/.test(text)) return "errored";
  if (/\b(delete|deleted|remove|removed|unlink|rm\s+-|rm\s)/.test(text)) return "deletes";
  if (/\b(write|edit|edited|patch|apply_patch|update|create|modified)\b/.test(text)) return "edits";
  if (/\b(command|exec|bash|shell|run)\b/.test(text)) return "commands";
  if (/\b(read|grep|glob|search|find|list|open)\b/.test(text)) return "reads";
  if (/\b(web|fetch|http|url|search_query)\b/.test(text)) return "web";
  return "other";
}

function codexVisibleItems(items: StreamItem[], mode: TranscriptMode, filter: ActionFilter): StreamItem[] {
  if (mode === "messages") return items.filter(isCodexMessageItem);
  if (mode === "actions") {
    return items.filter((item) => isCodexActionItem(item) && (filter === "all" || codexActionCategory(item) === filter));
  }
  return items;
}

function CodexLiveItem({ item }: { item: StreamItem }) {
  const t = item.type;
  if (t === "agent_message") {
    return <div className="part-text">{item.text ?? ""}</div>;
  }
  if (t === "reasoning") {
    const detail = codexItemDetail(item);
    return (
      <div className="codex-item codex-item-reasoning">
        <div className="codex-item-head">
          <Brain size={11} strokeWidth={2} /> reasoning
        </div>
        {detail && <div className="codex-item-body">{detail}</div>}
      </div>
    );
  }
  if (t === "command_execution" || t === "command" || t === "tool_call") {
    const detail = codexItemDetail(item);
    return (
      <div className="codex-item codex-item-tool">
        <div className="codex-item-head">
          <Wrench size={11} strokeWidth={2} /> {t.replace(/_/g, " ")}
          <span className={`codex-item-kind ${codexActionCategory(item)}`}>{codexActionCategory(item)}</span>
        </div>
        {detail && <div className="codex-item-body mono">{detail}</div>}
      </div>
    );
  }
  // Unknown item type — show a compact pill so we don't lose visibility.
  const detail = codexItemDetail(item);
  return (
    <div className="codex-item codex-item-unknown">
      <div className="codex-item-head">
        <MessageSquare size={11} strokeWidth={2} /> {t}
        {isCodexActionItem(item) && <span className={`codex-item-kind ${codexActionCategory(item)}`}>{codexActionCategory(item)}</span>}
      </div>
      {detail && <div className="codex-item-body">{detail}</div>}
    </div>
  );
}
