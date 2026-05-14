import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  Plus, Trash2, Menu, X,
  Paperclip, Image as ImageIcon, Cpu, FolderOpen, ChevronDown,
  TriangleAlert, FileText,
} from "lucide-react";
import { useStore, type Attachment, type Part, type Session } from "../lib/store";
import { PartView } from "./PartView";
import { AgentDiscoveryStrip } from "./AgentDiscoveryStrip";
import { AgentComposer } from "./AgentComposer";
import { AgentVaultLogButton } from "./AgentVaultLogButton";
import { AgentBuilderHandoffButton } from "./AgentBuilderHandoffButton";
import { TranscriptControls, type ActionFilter, type TranscriptMode } from "./TranscriptControls";
import { useSessionEndPrompt } from "../hooks/useSessionEndPrompt";

const PRESET_DIRS = [
  "/opt/newsbites",
  "/opt/mimoun",
  "/opt/paperclip",
  "/opt/opencode-control-surface",
  "/opt",
  "/root",
];

// ── Permission banner ──────────────────────────────────────────────────────

function PermissionBanner() {
  const { permission, replyPermission } = useStore();
  if (!permission) return null;

  const msg = permission.metadata?.message ?? "Tool execution requires your approval.";
  const title = permission.metadata?.title ?? "Permission required";

  return (
    <div className="permission-bar">
      <div className="permission-bar-title">
        <TriangleAlert size={12} />
        {title}
      </div>
      <div className="permission-bar-msg">{msg}</div>
      <div className="permission-btns">
        <button className="perm-btn allow" onClick={() => replyPermission(permission.id, "allow")}>allow</button>
        <button className="perm-btn deny" onClick={() => replyPermission(permission.id, "deny")}>deny</button>
      </div>
    </div>
  );
}

// ── Sessions panel ─────────────────────────────────────────────────────────

function SessionsPanel({
  onPickSession,
  onNewSession,
}: {
  onPickSession: (s: Session) => void;
  onNewSession: () => void;
}) {
  const { sessions, activeSession, deleteSession } = useStore();
  const sorted = [...sessions].sort((a, b) => b.time.updated - a.time.updated);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm("Delete this session?")) return;
    await deleteSession(id);
  };

  return (
    <div className="oc-panel">
      <button className="oc-new-session" onClick={onNewSession}>
        <Plus size={14} strokeWidth={2} /> New session
      </button>
      <div className="oc-session-list">
        {sorted.length === 0 && (
          <div className="oc-session-empty">no sessions yet</div>
        )}
        {sorted.map((s) => {
          const active = activeSession?.id === s.id;
          return (
            <div
              key={s.id}
              className={`oc-session-item${active ? " active" : ""}`}
              onClick={() => onPickSession(s)}
            >
              <div className="oc-session-content">
                <div className="oc-session-title">{s.title || s.slug || "untitled"}</div>
                <div className="oc-session-meta">
                  <span className="oc-session-dir">{s.directory}</span>
                  <span>{formatDistanceToNowStrict(s.time.updated, { addSuffix: true })}</span>
                </div>
              </div>
              <button className="oc-session-del" onClick={(e) => handleDelete(e, s.id)} aria-label="Delete">
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── New session modal ──────────────────────────────────────────────────────

function NewSessionModal({ onClose }: { onClose: () => void }) {
  const { sessions, createSession } = useStore();
  const [dir, setDir] = useState<string>("/opt");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const recent = useMemo(() => {
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const s of [...sessions].sort((a, b) => b.time.updated - a.time.updated)) {
      if (s.directory && !seen.has(s.directory)) {
        seen.add(s.directory);
        dirs.push(s.directory);
      }
      if (dirs.length >= 6) break;
    }
    return dirs;
  }, [sessions]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await createSession({ directory: dir.trim() || undefined });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box oc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">New session</div>
        <div className="modal-message">Pick a working directory for the session.</div>

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

        {recent.length > 0 && (
          <div className="oc-dir-group">
            <div className="oc-dir-group-label">Recent</div>
            <div className="oc-dir-chips">
              {recent.map((d) => (
                <button key={d} type="button" className="oc-dir-chip" onClick={() => setDir(d)}>
                  <FolderOpen size={11} /> {d}
                </button>
              ))}
            </div>
          </div>
        )}

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

// ── Model picker ──────────────────────────────────────────────────────────

function ModelPicker({ onClose }: { onClose: () => void }) {
  const { providers, currentModel, setModel, loadProviders } = useStore();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (providers.length === 0) loadProviders();
  }, [providers.length, loadProviders]);

  const flat = useMemo(() => {
    const all: Array<{ id: string; provider: string; name: string; cap: { image: boolean; attach: boolean } }> = [];
    for (const p of providers) {
      for (const m of Object.values(p.models ?? {})) {
        all.push({
          id: `${p.id}/${m.id}`,
          provider: p.name ?? p.id,
          name: m.name ?? m.id,
          cap: {
            image: !!m.capabilities?.input?.image,
            attach: !!m.capabilities?.attachment,
          },
        });
      }
    }
    return all;
  }, [providers]);

  const filtered = filter
    ? flat.filter((m) =>
        m.id.toLowerCase().includes(filter.toLowerCase()) ||
        m.name.toLowerCase().includes(filter.toLowerCase()) ||
        m.provider.toLowerCase().includes(filter.toLowerCase()))
    : flat;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box oc-model-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Choose model</div>
        <input
          className="modal-input"
          placeholder="Filter models…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        <div className="oc-model-list">
          {filtered.length === 0 && <div className="loading-dim">no models</div>}
          {filtered.map((m) => {
            const active = currentModel === m.id;
            return (
              <button
                key={m.id}
                className={`oc-model-row${active ? " active" : ""}`}
                onClick={async () => { await setModel(m.id); onClose(); }}
              >
                <div className="oc-model-name">{m.name}</div>
                <div className="oc-model-meta">
                  <span className="oc-model-id">{m.id}</span>
                  {m.cap.image && <span className="pill blue" style={{ fontSize: 9 }}>image</span>}
                  {m.cap.attach && <span className="pill blue" style={{ fontSize: 9 }}>attach</span>}
                </div>
              </button>
            );
          })}
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────

export function OpenCodeView() {
  const {
    sessions, activeSession, selectSession,
    messages, parts, messageOrder, messageParts, running, sendMessage,
    currentModel, providers, loadProviders, abortSession,
  } = useStore();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("all");
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (providers.length === 0) loadProviders();
  }, [providers.length, loadProviders]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageOrder.length, Object.keys(parts).length]);

  // Auto-pick first session when none selected and we have some
  useEffect(() => {
    if (!activeSession && sessions.length > 0) {
      const first = [...sessions].sort((a, b) => b.time.updated - a.time.updated)[0];
      selectSession(first);
    }
  }, [activeSession, sessions, selectSession]);

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return;
    const newAtts: Attachment[] = [];
    for (const f of Array.from(files)) {
      const url = await fileToDataUrl(f);
      newAtts.push({
        id: crypto.randomUUID(),
        filename: f.name,
        mime: f.type || "application/octet-stream",
        url,
        size: f.size,
        kind: f.type.startsWith("image/") ? "image" : "file",
      });
    }
    setAttachments((prev) => [...prev, ...newAtts]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || !activeSession || running) return;
    const atts = attachments;
    setInput("");
    setAttachments([]);
    await sendMessage(text, atts);
  };

  const orderedMsgs = useMemo(() => (
    messageOrder
      .map((id) => messages.find((m) => m.info.id === id))
      .filter(Boolean) as typeof messages
  ), [messageOrder, messages]);

  const transcriptCounts = useMemo(() => {
    const allParts = orderedMsgs.flatMap((msg) => {
      const livePartIds = messageParts[msg.info.id] ?? msg.parts.map((p) => p.id);
      return livePartIds
        .map((pid) => parts[pid] ?? msg.parts.find((p) => p.id === pid))
        .filter(Boolean) as Part[];
    });
    return {
      messages: allParts.filter(isOpenCodeMessagePart).length,
      actions: allParts.filter(isOpenCodeActionPart).length,
      thoughts: allParts.filter((part) => part.type === "reasoning").length,
      errored: allParts.filter((part) => isOpenCodeActionPart(part) && openCodeActionCategory(part) === "errored").length,
      edits: allParts.filter((part) => isOpenCodeActionPart(part) && openCodeActionCategory(part) === "edits").length,
      deletes: allParts.filter((part) => isOpenCodeActionPart(part) && openCodeActionCategory(part) === "deletes").length,
    };
  }, [messageParts, orderedMsgs, parts]);

  const sessionEndMessages = useMemo(() => orderedMsgs.map((msg) => {
    const livePartIds = messageParts[msg.info.id] ?? msg.parts.map((p) => p.id);
    const liveParts = livePartIds
      .map((pid) => parts[pid] ?? msg.parts.find((p) => p.id === pid))
      .filter(Boolean);
    const text: string[] = [];
    const filePaths: string[] = [];
    const toolText: string[] = [];

    for (const part of liveParts) {
      if (!part) continue;
      if (part.type === "text" || part.type === "reasoning") {
        text.push((part as { text?: string }).text ?? "");
      } else if (part.type === "patch") {
        filePaths.push(...((part as { files?: string[] }).files ?? []));
      } else if (part.type === "tool") {
        const toolPart = part as { tool?: string; state?: unknown };
        toolText.push(`${toolPart.tool ?? "tool"} ${safeJson(toolPart.state)}`);
      } else if (part.type === "file") {
        text.push((part as { filename?: string }).filename ?? "");
      }
    }

    return {
      role: msg.info.role,
      content: text.join("\n"),
      toolText: toolText.join("\n"),
      filePaths,
    };
  }), [messageParts, orderedMsgs, parts]);
  const { triggerSessionEnd, sessionEndPromptModal } = useSessionEndPrompt({
    agent: "opencode",
    sessionId: activeSession?.id,
    title: activeSession?.title || activeSession?.slug,
    directory: activeSession?.directory,
    messages: sessionEndMessages,
  });
  const openNewSession = () => {
    setDrawerOpen(false);
    if (!triggerSessionEnd("new-session", () => setNewSessionOpen(true))) setNewSessionOpen(true);
  };

  const modelLabel = currentModel ?? "auto";

  return (
    <div className="oc-shell">
      {/* Top bar */}
      <header className="oc-topbar">
        <button className="oc-icon-btn" aria-label="Sessions" onClick={() => setDrawerOpen(true)}>
          <Menu size={18} strokeWidth={1.75} />
        </button>
        <div className="oc-topbar-titles">
          <div className="oc-topbar-title">{activeSession?.title || activeSession?.slug || "OpenCode"}</div>
          {activeSession?.directory && (
            <div className="oc-topbar-dir">{activeSession.directory}</div>
          )}
        </div>
        <button className="oc-model-btn" onClick={() => setModelPickerOpen(true)}>
          <Cpu size={13} strokeWidth={1.75} />
          <span className="oc-model-label">{modelLabel}</span>
          <ChevronDown size={12} />
        </button>
        {activeSession && (
          <AgentBuilderHandoffButton
            agent="opencode"
            sessionId={activeSession.id}
            title={activeSession.title || activeSession.slug || "OpenCode session"}
            directory={activeSession.directory}
            messageCount={messageOrder.length}
            messages={sessionEndMessages}
          />
        )}
        {activeSession && (
          <AgentVaultLogButton
            agent="opencode"
            sessionId={activeSession.id}
            title={activeSession.title || activeSession.slug || "OpenCode session"}
            directory={activeSession.directory}
            messageCount={messageOrder.length}
          />
        )}
      </header>

      {/* Sessions drawer (mobile) + permanent (desktop) */}
      <aside className={`oc-sessions${drawerOpen ? " open" : ""}`}>
        <div className="oc-sessions-head">
          <span className="oc-sessions-title">Sessions</span>
          <button className="oc-icon-btn oc-drawer-close" aria-label="Close" onClick={() => setDrawerOpen(false)}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <SessionsPanel
          onPickSession={(s) => { selectSession(s); setDrawerOpen(false); }}
          onNewSession={openNewSession}
        />
      </aside>
      {drawerOpen && <div className="oc-drawer-backdrop" onClick={() => setDrawerOpen(false)} />}

      {/* Chat area */}
      <main className="oc-main">
        <AgentDiscoveryStrip agent="opencode" onInsert={(t) => setInput((prev) => prev + t)} />
        {activeSession && (
          <TranscriptControls
            mode={transcriptMode}
            actionFilter={actionFilter}
            counts={transcriptCounts}
            onModeChange={setTranscriptMode}
            onActionFilterChange={setActionFilter}
          />
        )}
        {!activeSession ? (
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
            {orderedMsgs.length === 0 && (
              <div className="oc-thread-hint">Session ready — send a message to begin.</div>
            )}

            {orderedMsgs.map((msg, msgIdx) => {
              const isUser = msg.info.role === "user";
              const livePartIds = messageParts[msg.info.id] ?? msg.parts.map((p) => p.id);
              const liveParts = livePartIds
                .map((pid) => parts[pid] ?? msg.parts.find((p) => p.id === pid))
                .filter(Boolean);
              const isLastMsg = msgIdx === orderedMsgs.length - 1;

              if (isUser) {
                const textPart = liveParts.find((p) => p?.type === "text") as { text: string } | undefined;
                const text = textPart?.text ?? "";
                const fileParts = liveParts.filter((p) => p?.type === "file") as Array<{ filename?: string; mime?: string; url?: string }>;
                return (
                  <div key={msg.info.id} className="msg-wrap">
                    <div className="msg-user">
                      <div className="msg-user-bubble">
                        {fileParts.length > 0 && (
                          <div className="msg-attachments">
                            {fileParts.map((f, i) => (
                              <div key={i} className="msg-attachment">
                                {f.mime?.startsWith("image/") && f.url ? (
                                  <img src={f.url} alt={f.filename} />
                                ) : (
                                  <div className="msg-attachment-file">
                                    <FileText size={12} /> {f.filename}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {text}
                      </div>
                    </div>
                  </div>
                );
              }

              const visibleParts = openCodeVisibleParts(
                liveParts.filter(Boolean) as Part[],
                transcriptMode,
                actionFilter,
              );
              if (visibleParts.length === 0 && !running) return null;

              return (
                <div key={msg.info.id} className="msg-wrap">
                  <div className="msg-assistant">
                    <div className="msg-label model">{msg.info.modelID ?? "assistant"}</div>
                    {visibleParts.map((part, partIdx) => (
                      <PartView
                        key={part!.id}
                        part={part!}
                        isLast={isLastMsg && partIdx === visibleParts.length - 1}
                        running={running}
                        defaultOpenActions={transcriptMode === "actions"}
                      />
                    ))}
                    {isLastMsg && running && visibleParts.length === 0 && (
                      <div className="part-text"><span className="stream-cursor" /></div>
                    )}
                  </div>
                </div>
              );
            })}

            {orderedMsgs.length > 0 && !running && transcriptMode === "actions" && transcriptCounts.actions > 0 && orderedMsgs.every((msg) => {
              if (msg.info.role === "user") return true;
              const livePartIds = messageParts[msg.info.id] ?? msg.parts.map((p) => p.id);
              const liveParts = livePartIds
                .map((pid) => parts[pid] ?? msg.parts.find((p) => p.id === pid))
                .filter(Boolean) as Part[];
              return openCodeVisibleParts(liveParts, transcriptMode, actionFilter).length === 0;
            }) && (
              <div className="oc-thread-hint">No actions match this filter.</div>
            )}

            <div className="msg-wrap"><PermissionBanner /></div>
            <div ref={bottomRef} />
          </div>
        )}

        {/* Composer */}
        {activeSession && (
          <AgentComposer
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            onStop={abortSession}
            running={running}
            placeholder="Message OpenCode"
            agent="opencode"
            workspace={activeSession.directory}
            canSubmit={input.trim().length > 0 || attachments.length > 0}
            aboveRow={attachments.length > 0 ? (
              <div className="oc-attach-row">
                {attachments.map((a) => (
                  <div key={a.id} className="oc-attach-chip">
                    {a.kind === "image" ? <ImageIcon size={11} /> : <Paperclip size={11} />}
                    <span className="oc-attach-name">{a.filename}</span>
                    <button onClick={() => removeAttachment(a.id)} aria-label="Remove">
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            leftButtons={(
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => { onPickFiles(e.target.files); e.target.value = ""; }}
                />
                <button
                  type="button"
                  className="oc-icon-btn"
                  aria-label="Attach"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={16} strokeWidth={1.75} />
                </button>
              </>
            )}
          />
        )}
      </main>

      {newSessionOpen && <NewSessionModal onClose={() => setNewSessionOpen(false)} />}
      {modelPickerOpen && <ModelPicker onClose={() => setModelPickerOpen(false)} />}
      {sessionEndPromptModal}
    </div>
  );
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isOpenCodeMessagePart(part: Part): boolean {
  return part.type === "text";
}

function isOpenCodeActionPart(part: Part): boolean {
  return part.type === "tool" || part.type === "patch";
}

function openCodeActionCategory(part: Part): ActionFilter {
  const text = openCodePartSearchText(part);
  if (/\b(error|failed|exit code|non-zero|exception)\b/.test(text)) return "errored";
  if (/\b(delete|deleted|remove|removed|unlink|rm\s+-|rm\s)/.test(text)) return "deletes";
  if (/\b(write|edit|edited|patch|apply_patch|update|create|modified)\b/.test(text)) return "edits";
  if (/\b(bash|exec|command|shell|run)\b/.test(text)) return "commands";
  if (/\b(read|grep|glob|search|find|list|open)\b/.test(text)) return "reads";
  if (/\b(web|fetch|http|url)\b/.test(text)) return "web";
  return "other";
}

function openCodeVisibleParts(parts: Part[], mode: TranscriptMode, filter: ActionFilter): Part[] {
  if (mode === "messages") return parts.filter(isOpenCodeMessagePart);
  if (mode === "actions") {
    return parts.filter((part) => isOpenCodeActionPart(part) && (filter === "all" || openCodeActionCategory(part) === filter));
  }
  return parts.filter((part) => part.type !== "step-start" && part.type !== "step-finish");
}

function openCodePartSearchText(part: Part): string {
  if (part.type === "patch") {
    return `patch ${(part as { files?: string[] }).files?.join(" ") ?? ""}`.toLowerCase();
  }
  if (part.type !== "tool") return part.type.toLowerCase();

  const toolPart = part as Extract<Part, { type: "tool" }>;
  const state = toolPart.state as unknown;
  return `${toolPart.tool} ${safeJson(state)}`.toLowerCase();
}
