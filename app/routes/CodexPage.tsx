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
};

type CodexMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
};

type StreamItem = {
  id: string;
  type: string; // "agent_message" | "reasoning" | "command_execution" | other
  text?: string;
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
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveItems, setLiveItems] = useState<StreamItem[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadList = async () => {
    try {
      const res = await authFetch("/api/codex/sessions");
      const json = await res.json() as { sessions: CodexSessionMeta[] };
      setSessions(json.sessions);
      return json.sessions;
    } catch {
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

  const selectSession = async (id: string) => {
    setError(null);
    try {
      const res = await authFetch(`/api/codex/sessions/${id}`);
      const json = await res.json() as { session: CodexSession };
      setActive(json.session);
      setDrawerOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteSession = async (id: string) => {
    if (!confirm("Delete this Codex session? (Codex's own history file will not be deleted.)")) return;
    await authFetch(`/api/codex/sessions/${id}`, { method: "DELETE" });
    if (active?.id === id) setActive(null);
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
        setActive(json.session);
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

  const stop = () => {
    abortRef.current?.abort();
  };

  const orderedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const sessionEndMessages = useMemo(() => (
    active?.messages.map((m) => ({
      role: m.role,
      content: m.content,
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
        <AgentDiscoveryStrip agent="codex" />
        {!active ? (
          <div className="oc-empty">
            <FileText size={32} strokeWidth={1.25} />
            <div className="oc-empty-title">No session</div>
            <div className="oc-empty-sub">Open the menu to pick a session, or start a new one.</div>
            <button className="btn btn-primary" onClick={openNewSession}>
              <Plus size={14} /> New session
            </button>
            <div className="oc-codex-note">
              Codex runs as <code>codex exec</code> in the directory you pick. Single-shot per
              message — full streaming &amp; tool-use UI is on the roadmap.
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
              return (
                <div key={m.id} className="msg-wrap">
                  <div className="msg-assistant">
                    <div className={`msg-label model${isSystem ? " err" : ""}`}>
                      {isSystem ? "codex (error)" : "codex"}
                    </div>
                    <div className="part-text">{m.content}</div>
                  </div>
                </div>
              );
            })}
            {sending && (
              <div className="msg-wrap">
                <div className="msg-assistant">
                  <div className="msg-label model">codex</div>
                  {liveItems.length === 0 ? (
                    <div className="part-text oc-codex-thinking">
                      <Loader2 size={12} className="oc-spin" /> thinking…
                    </div>
                  ) : (
                    liveItems.map((it, idx) => <CodexLiveItem key={idx} item={it} />)
                  )}
                  {liveItems.length > 0 && (
                    <div className="oc-codex-thinking" style={{ marginTop: 6 }}>
                      <Loader2 size={11} className="oc-spin" /> running…
                    </div>
                  )}
                </div>
              </div>
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
    </div>
  );
}

function CodexLiveItem({ item }: { item: StreamItem }) {
  const t = item.type;
  if (t === "agent_message") {
    return <div className="part-text">{item.text ?? ""}</div>;
  }
  if (t === "reasoning") {
    return (
      <div className="codex-item codex-item-reasoning">
        <div className="codex-item-head">
          <Brain size={11} strokeWidth={2} /> reasoning
        </div>
        {item.text && <div className="codex-item-body">{item.text}</div>}
      </div>
    );
  }
  if (t === "command_execution" || t === "command" || t === "tool_call") {
    return (
      <div className="codex-item codex-item-tool">
        <div className="codex-item-head">
          <Wrench size={11} strokeWidth={2} /> {t.replace(/_/g, " ")}
        </div>
        {item.text && <div className="codex-item-body mono">{item.text}</div>}
      </div>
    );
  }
  // Unknown item type — show a compact pill so we don't lose visibility.
  return (
    <div className="codex-item codex-item-unknown">
      <div className="codex-item-head">
        <MessageSquare size={11} strokeWidth={2} /> {t}
      </div>
      {item.text && <div className="codex-item-body">{item.text}</div>}
    </div>
  );
}
