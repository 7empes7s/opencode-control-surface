import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  Plus, Trash2, Menu, X,
  ChevronDown, FolderOpen, FileText, Sparkles, Loader2,
  Wrench, AlertTriangle,
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

type GeminiSessionMeta = {
  id: string;
  title: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  geminiSessionId: string | null;
  running?: boolean;
  runStartedAt?: number | null;
};

type GeminiMessageT = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
};

type StreamItem =
  | { kind: "assistant"; text: string }
  | { kind: "tool_use"; name: string; input: unknown };

type GeminiSessionT = GeminiSessionMeta & { messages: GeminiMessageT[] };

function NewGeminiModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: GeminiSessionT) => void }) {
  const [dir, setDir] = useState("/opt");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await authFetch("/api/gemini/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: dir.trim(), title: title.trim() || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json() as { session: GeminiSessionT };
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
        <div className="modal-title">New Gemini session</div>
        <div className="modal-message">Working directory shapes everything Gemini sees.</div>

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

export function GeminiPage() {
  const [sessions, setSessions] = useState<GeminiSessionMeta[]>([]);
  const [active, setActive] = useState<GeminiSessionT | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [yoloConfirm, setYoloConfirm] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveItems, setLiveItems] = useState<StreamItem[]>([]);
  const [runtimeOptions, setRuntimeOptions] = useState({
    model: "gemini-2.5-flash",
    approvalMode: "default" as "default" | "auto_edit" | "plan" | "yolo",
    outputFormat: "stream-json" as "stream-json" | "text",
  });
  const [geminiModels, setGeminiModels] = useState<{ name: string; label: string }[]>([
    { name: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    { name: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    { name: "gemini-1.5-flash", label: "gemini-1.5-flash" },
    { name: "gemini-1.5-pro", label: "gemini-1.5-pro" },
  ]);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("all");
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadList = async () => {
    try {
      const res = await authFetch("/api/gemini/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { sessions: GeminiSessionMeta[] };
      const list = Array.isArray(json.sessions) ? json.sessions : [];
      setSessions(list);
      return list;
    } catch (e) {
      setSessions([]);
      setError(e instanceof Error ? e.message : String(e));
      return [] as GeminiSessionMeta[];
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
    const loadModels = async () => {
      try {
        const res = await authFetch("/api/models");
        if (!res.ok) return;
        const json = await res.json() as { models?: Array<{ provider?: string; logicalName?: string; label?: string; available?: boolean }> };
        const models = json.models ?? [];
        const geminiEntries = models.filter(
          (m) => (m.provider === "gemini" || (m.available && (m.logicalName ?? m.label ?? "").toLowerCase().includes("gemini")))
        );
        if (geminiEntries.length > 0) {
          setGeminiModels(geminiEntries.map((m) => ({ name: m.logicalName ?? m.label ?? "", label: m.label ?? m.logicalName ?? "" })));
        }
      } catch { /* fallback preserved */ }
    };
    loadModels();
  }, []);

  useEffect(() => {
    setRuntimeOptions({
      model: "gemini-2.5-flash",
      approvalMode: "default",
      outputFormat: "stream-json",
    });
  }, [active?.id]);

  useEffect(() => {
    if (!active?.id || !active.running) return;
    setSending(true);
    const poll = async () => {
      try {
        const res = await authFetch(`/api/gemini/sessions/${active.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as { session: GeminiSessionT };
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
      const res = await authFetch(`/api/gemini/sessions/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { session: GeminiSessionT };
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
    await authFetch(`/api/gemini/sessions/${deleteTarget.id}`, { method: "DELETE" });
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

    const userMsg: GeminiMessageT = {
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
      let approvalMode = runtimeOptions.approvalMode;
      if (approvalMode === "yolo" && !yoloConfirm) {
        setYoloConfirm(true);
        setSending(false);
        return;
      }
      setYoloConfirm(false);
      const res = await authFetch(`/api/gemini/sessions/${active.id}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, approvalMode, outputFormat: runtimeOptions.outputFormat }),
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
        if (eventName === "message") {
          const p = payload as { role?: string; content?: string; delta?: boolean };
          if (p.role === "assistant" && typeof p.content === "string") {
            setLiveItems((prev) => [...prev, { kind: "assistant", text: p.content }]);
          }
        } else if (eventName === "tool_use") {
          const p = payload as { name?: string; input?: unknown };
          setLiveItems((prev) => [...prev, { kind: "tool_use", name: p.name ?? "tool", input: p.input }]);
        } else if (eventName === "error") {
          streamErr = (payload as { error?: string }).error ?? "unknown error";
          setError(streamErr);
        } else if (eventName === "done") {
          // server has already persisted the assistant message; we'll refetch below
        }
      };

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

      const fetched = await authFetch(`/api/gemini/sessions/${active.id}`);
      if (fetched.ok) {
        const json = await fetched.json() as { session: GeminiSessionT };
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
      await authFetch(`/api/gemini/sessions/${active.id}/stop`, { method: "POST" }).catch(() => null);
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
    })) ?? []
  ), [active?.messages]);
  const { triggerSessionEnd, sessionEndPromptModal } = useSessionEndPrompt({
    agent: "gemini",
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
    <div className="oc-shell gemini-shell">
      <header className="oc-topbar">
        <button className="oc-icon-btn" aria-label="Sessions" onClick={() => setDrawerOpen(true)}>
          <Menu size={18} strokeWidth={1.75} />
        </button>
        <div className="oc-topbar-titles">
          <div className="oc-topbar-title">{active?.title ?? "Gemini"}</div>
          {active?.directory && <div className="oc-topbar-dir">{active.directory}</div>}
        </div>
        <span className="oc-model-btn" style={{ cursor: "default" }}>
          <Sparkles size={13} strokeWidth={1.75} />
          <span className="oc-model-label">gemini-cli</span>
          <ChevronDown size={12} style={{ opacity: 0.3 }} />
        </span>
        {active && (
          <AgentBuilderHandoffButton
            agent="gemini"
            sessionId={active.id}
            title={active.title}
            directory={active.directory}
            messageCount={active.messages.length}
            messages={sessionEndMessages}
          />
        )}
        {active && (
          <AgentVaultLogButton
            agent="gemini"
            sessionId={active.id}
            title={active.title}
            directory={active.directory}
            messageCount={active.messages.length}
          />
        )}
      </header>

      <aside className={`oc-sessions${drawerOpen ? " open" : ""}`}>
        <div className="oc-sessions-head">
          <span className="oc-sessions-title">Gemini sessions</span>
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
        <AgentDiscoveryStrip agent="gemini" onInsert={(t) => setInput((prev) => prev + t)} />
        {active && (
          <TranscriptControls
            mode={transcriptMode}
            actionFilter={actionFilter}
            counts={{ messages: active.messages.length, actions: 0, thoughts: 0, errored: active.messages.filter((m) => m.role === "system").length, edits: 0, deletes: 0 }}
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
                if (transcriptMode === "actions") return null;
                return (
                  <div key={m.id} className="msg-wrap">
                    <div className="msg-user"><div className="msg-user-bubble">{m.content}</div></div>
                  </div>
                );
              }
              if (transcriptMode === "actions" && isSystem) return null;
              return (
                <div key={m.id} className="msg-wrap">
                  <div className="msg-assistant">
                    <div className={`msg-label model${isSystem ? " err" : ""}`}>
                      {isSystem ? "gemini (error)" : "gemini"}
                    </div>
                    <div className="part-text">{m.content}</div>
                  </div>
                </div>
              );
            })}
            {sending && (
              <div className="msg-wrap">
                <div className="msg-assistant">
                  <div className="msg-label model">gemini</div>
                  {active.running && liveItems.length === 0 ? (
                    <div className="part-text oc-codex-thinking">
                      <Loader2 size={12} className="oc-spin" /> running in background...
                    </div>
                  ) : liveItems.length === 0 ? (
                    <div className="part-text oc-codex-thinking">
                      <Loader2 size={12} className="oc-spin" /> thinking…
                    </div>
                  ) : (
                    liveItems.map((it, idx) => <GeminiLiveItem key={idx} item={it} />)
                  )}
                  {liveItems.length > 0 && (
                    <div className="oc-codex-thinking" style={{ marginTop: 6 }}>
                      <Loader2 size={11} className="oc-spin" /> running…
                    </div>
                  )}
                </div>
              </div>
            )}
            {error && (
              <div className="loading-dim error" style={{ padding: "8px 20px", display: "flex", alignItems: "center", gap: 6 }}>
                <AlertTriangle size={12} /> {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}

        {active && (
          <div className="oc-runtime-bar">
            <label>Model</label>
            <select
              value={runtimeOptions.model}
              onChange={(e) => setRuntimeOptions((o) => ({ ...o, model: e.target.value }))}
            >
              {geminiModels.map((m) => (
                <option key={m.name} value={m.name}>{m.label}</option>
              ))}
            </select>
            <label>Approval</label>
            <select
              value={runtimeOptions.approvalMode}
              onChange={(e) => setRuntimeOptions((o) => ({ ...o, approvalMode: e.target.value as typeof o.approvalMode }))}
            >
              <option value="default">default</option>
              <option value="auto_edit">auto_edit</option>
              <option value="plan">plan</option>
              <option value="yolo">yolo ⚠</option>
            </select>
            <label>Output</label>
            <select
              value={runtimeOptions.outputFormat}
              onChange={(e) => setRuntimeOptions((o) => ({ ...o, outputFormat: e.target.value as typeof o.outputFormat }))}
            >
              <option value="stream-json">stream-json</option>
              <option value="text">text</option>
            </select>
            {runtimeOptions.model !== "gemini-2.5-flash" && (
              <span className="oc-yolo-warn">model: {runtimeOptions.model}</span>
            )}
          </div>
        )}

        {active && (
          <AgentComposer
            value={input}
            onChange={setInput}
            onSubmit={send}
            onStop={stop}
            running={sending}
            placeholder="Message Gemini"
            agent="gemini"
            workspace={active.directory}
          />
        )}
      </main>

      {newOpen && (
        <NewGeminiModal
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
          message={`Delete "${deleteTarget.title}"?`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDeleteSession}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {yoloConfirm && (
        <ConfirmModal
          title="Yolo Mode Warning"
          message="Yolo mode can modify files without approval. Continue?"
          confirmLabel="Yes, proceed"
          danger
          onConfirm={() => {
            setYoloConfirm(false);
            send();
          }}
          onCancel={() => {
            setYoloConfirm(false);
            setSending(false);
          }}
        />
      )}
    </div>
  );
}

function GeminiLiveItem({ item }: { item: StreamItem }) {
  if (item.kind === "assistant") {
    return <div className="part-text">{item.text}</div>;
  }
  const inputStr = (() => {
    try { return JSON.stringify(item.input); } catch { return ""; }
  })();
  return (
    <div className="codex-item codex-item-tool">
      <div className="codex-item-head">
        <Wrench size={11} strokeWidth={2} /> {item.name}
      </div>
      {inputStr && <div className="codex-item-body mono">{inputStr}</div>}
    </div>
  );
}
