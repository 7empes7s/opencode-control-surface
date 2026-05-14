import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Mic, MicOff, Send, Square } from "lucide-react";
import { useVoice } from "../hooks/useVoice";

type AgentId = "claude" | "codex" | "opencode" | "gemini";

type CatalogItem = {
  kind: "skill" | "command" | "prompt";
  name: string;
  description: string;
  source: string;
  sourcePath?: string;
  insertText?: string;
  risk?: "low" | "medium" | "high";
};

type CatalogResponse = {
  skills?: Array<{
    name: string;
    description: string;
    source: string;
    sourcePath: string;
  }>;
  commands?: Array<{
    name: string;
    description: string;
    source: string;
    sourcePath?: string;
  }>;
  quickPrompts?: Array<{
    name: string;
    description: string;
    source: string;
    sourcePath?: string;
    insertText: string;
    risk?: "low" | "medium" | "high";
  }>;
};

export interface AgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  running: boolean;
  placeholder?: string;
  /** Override the default "value has trimmed text" rule (e.g. to allow attachments-only). */
  canSubmit?: boolean;
  /** Extra buttons on the left of the textarea (e.g. attach). Voice button is always rendered when supported. */
  leftButtons?: ReactNode;
  /** Row rendered above the composer row (e.g. attachment chips). */
  aboveRow?: ReactNode;
  /** Enables the slash picker with agent-compatible skills and commands. */
  agent?: AgentId;
  workspace?: string;
}

function riskFor(item: CatalogItem): "low" | "medium" | "high" {
  if (item.risk) return item.risk;
  const text = `${item.name} ${item.description}`.toLowerCase();
  if (/\b(deploy|publish|restart|delete|remove|write|edit|fix|make)\b/.test(text)) return "high";
  if (/\b(check|status|inspect|read|review|audit)\b/.test(text)) return "low";
  return "medium";
}

function insertTextFor(item: CatalogItem, workspace?: string): string {
  if (item.kind === "command") return `/${item.name} `;
  if (item.kind === "prompt" && item.insertText) return item.insertText;
  return `Use the ${item.name} skill. ${item.description}`;
}

/**
 * Shared composer shell for Claude / Codex / OpenCode pages.
 *
 * Owns: textarea autosize, Enter-to-send, Web Speech voice, Send/Stop button.
 * Does not own: send transport, attachments state, model selection — parents pass those in.
 */
export function AgentComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  placeholder,
  canSubmit,
  leftButtons,
  aboveRow,
  agent,
  workspace,
}: AgentComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  useEffect(() => {
    if (!running || !onStop) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onStop();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [running, onStop]);

  const voice = useVoice((t) => onChange(value ? `${value} ${t}` : t));
  const slash = useMemo(() => {
    if (!agent || running) return null;
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const match = before.match(/(^|\s)\/([A-Za-z0-9_-]*)$/);
    if (!match) return null;
    return {
      cursor,
      start: cursor - match[2].length - 1,
      query: match[2].toLowerCase(),
    };
  }, [agent, running, value]);

  useEffect(() => {
    setCatalog([]);
    setCatalogError(null);
  }, [agent, workspace]);

  useEffect(() => {
    if (!agent || !slash || catalog.length > 0 || catalogError) return;
    let cancelled = false;
    const quickUrl = `/api/agents/quick-prompts?agent=${agent}${workspace ? `&cwd=${encodeURIComponent(workspace)}` : ""}`;
    Promise.all([
      fetch(quickUrl).then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json() as Promise<CatalogResponse>;
      }),
      fetch(`/api/agents/skills?agent=${agent}`).then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json() as Promise<CatalogResponse>;
      }),
    ])
      .then(([quickJson, catalogJson]) => {
        if (cancelled) return;
        const prompts: CatalogItem[] = (quickJson.quickPrompts ?? []).map((item) => ({
          kind: "prompt",
          name: item.name,
          description: item.description,
          source: item.source,
          sourcePath: item.sourcePath,
          insertText: item.insertText,
          risk: item.risk,
        }));
        const skills: CatalogItem[] = (catalogJson.skills ?? []).map((item) => ({
          kind: "skill",
          name: item.name,
          description: item.description,
          source: item.source,
          sourcePath: item.sourcePath,
        }));
        const commands: CatalogItem[] = (catalogJson.commands ?? []).map((item) => ({
          kind: "command",
          name: item.name,
          description: item.description,
          source: item.source,
          sourcePath: item.sourcePath,
        }));
        setCatalog([...prompts, ...skills, ...commands]);
      })
      .catch((e) => {
        if (!cancelled) setCatalogError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [agent, workspace, slash, catalog.length, catalogError]);

  const matches = useMemo(() => {
    if (!slash) return [];
    const q = slash.query;
    return catalog
      .filter((item) => {
        if (!q) return true;
        return item.name.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.source.toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [catalog, slash]);

  useEffect(() => {
    setActiveIndex(0);
  }, [slash?.query]);

  const insertSlashItem = (item: CatalogItem) => {
    if (!slash) return;
    const next = `${value.slice(0, slash.start)}${insertTextFor(item, workspace)}${value.slice(slash.cursor)}`;
    onChange(next);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (slash && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((idx) => (idx + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((idx) => (idx - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        insertSlashItem(matches[activeIndex] ?? matches[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onChange(value.slice(0, slash.start) + value.slice(slash.cursor));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!running && allowSend) onSubmit();
    }
  };

  const allowSend = canSubmit ?? value.trim().length > 0;
  const effectivePlaceholder = running
    ? "waiting…"
    : (placeholder ?? "Message");

  return (
    <div className="oc-composer">
      {aboveRow}
      {slash && (
        <div className="slash-picker">
          {catalogError ? (
            <div className="slash-picker-empty">catalog unavailable</div>
          ) : matches.length > 0 ? (
            matches.map((item, idx) => {
              const risk = riskFor(item);
              return (
                <button
                  key={`${item.kind}:${item.source}:${item.name}`}
                  type="button"
                  className={`slash-item${idx === activeIndex ? " active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertSlashItem(item);
                  }}
                >
                  <span className={`slash-kind ${item.kind}`}>{item.kind}</span>
                  <span className="slash-main">
                    <span className="slash-name">/{item.name}</span>
                    <span className="slash-desc">{item.description}</span>
                    {item.sourcePath && <span className="slash-path">{item.sourcePath}</span>}
                  </span>
                  <span className={`slash-risk ${risk}`}>{risk}</span>
                </button>
              );
            })
          ) : (
            <div className="slash-picker-empty">no matches</div>
          )}
        </div>
      )}
      <div className="oc-composer-row">
        {leftButtons}
        {voice.supported && (
          <button
            type="button"
            className={`oc-icon-btn${voice.listening ? " active" : ""}`}
            aria-label={voice.listening ? "Stop voice" : "Start voice"}
            onClick={() => (voice.listening ? voice.stop() : voice.start())}
          >
            {voice.listening ? (
              <MicOff size={16} strokeWidth={1.75} />
            ) : (
              <Mic size={16} strokeWidth={1.75} />
            )}
          </button>
        )}
        <textarea
          ref={textareaRef}
          className="oc-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={effectivePlaceholder}
          disabled={running}
          rows={1}
        />
        {running && onStop ? (
          <button
            type="button"
            className="oc-send-btn stop"
            aria-label="Stop"
            onClick={onStop}
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : !running ? (
          <button
            type="button"
            className="oc-send-btn"
            aria-label="Send"
            onClick={onSubmit}
            disabled={!allowSend}
          >
            <Send size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
