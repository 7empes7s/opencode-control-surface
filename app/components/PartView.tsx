import { useEffect, useState } from "react";
import type { Part, ToolState } from "../lib/store";
import { ChevronRight, ChevronDown, Terminal, FileEdit, Search, Globe, Wrench } from "lucide-react";

// ── Text rendering with basic markdown ────────────────────────────────────

function renderText(text: string) {
  const segments: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // code block
    const cbMatch = remaining.match(/^([\s\S]*?)```(\w*)\n?([\s\S]*?)```/);
    if (cbMatch) {
      if (cbMatch[1]) segments.push(<span key={key++}>{cbMatch[1]}</span>);
      const lang = cbMatch[2] || "text";
      segments.push(
        <pre key={key++}>
          <div className="code-header">
            <span>{lang}</span>
          </div>
          <code>{cbMatch[3]}</code>
        </pre>
      );
      remaining = remaining.slice(cbMatch[0].length);
      continue;
    }

    // inline code
    const icMatch = remaining.match(/^([\s\S]*?)`([^`]+)`/);
    if (icMatch) {
      if (icMatch[1]) segments.push(<span key={key++}>{icMatch[1]}</span>);
      segments.push(<code key={key++}>{icMatch[2]}</code>);
      remaining = remaining.slice(icMatch[0].length);
      continue;
    }

    // bold
    const boldMatch = remaining.match(/^([\s\S]*?)\*\*(.+?)\*\*/);
    if (boldMatch) {
      if (boldMatch[1]) segments.push(<span key={key++}>{boldMatch[1]}</span>);
      segments.push(<strong key={key++} style={{ color: "var(--text-bright)" }}>{boldMatch[2]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    segments.push(<span key={key++}>{remaining}</span>);
    remaining = "";
  }

  return segments;
}

// ── Tool icon ──────────────────────────────────────────────────────────────

function ToolIcon({ tool }: { tool: string }) {
  const t = tool.toLowerCase();
  if (t.includes("bash") || t.includes("exec") || t.includes("run")) return <Terminal size={12} style={{ color: "var(--amber)" }} />;
  if (t.includes("write") || t.includes("edit") || t.includes("patch")) return <FileEdit size={12} style={{ color: "var(--blue)" }} />;
  if (t.includes("read") || t.includes("glob") || t.includes("grep") || t.includes("search")) return <Search size={12} style={{ color: "var(--text-dim)" }} />;
  if (t.includes("fetch") || t.includes("web") || t.includes("http")) return <Globe size={12} style={{ color: "var(--blue)" }} />;
  return <Wrench size={12} style={{ color: "var(--text-dim)" }} />;
}

// ── Tool part ──────────────────────────────────────────────────────────────

function ToolPartView({ part, defaultOpen = false }: { part: Extract<Part, { type: "tool" }>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const state = part.state as ToolState;

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const statusLabel = state.status;
  const title = state.status !== "pending" ? (state as { title?: string }).title ?? "" : "";
  const output = state.status === "completed" ? (state as { output: string }).output : "";
  const error = state.status === "error" ? (state as { error: string }).error : "";
  const inputStr = state.status === "pending"
    ? (state as { raw: string }).raw
    : JSON.stringify((state as { input: Record<string, unknown> }).input, null, 2);
  const body = [inputStr, output, error].filter(Boolean).join("\n\n");
  const preview = (output || error || inputStr || "").replace(/\s+/g, " ").trim();

  return (
    <div className={`part-tool status-${state.status}`}>
      <button className="part-tool-header" onClick={() => setOpen((v) => !v)}>
        <ToolIcon tool={part.tool} />
        <span className="tool-name-text">
          {part.tool}
          {title && <span className="tool-title"> {title}</span>}
        </span>
        <span className={`tool-badge ${state.status}`}>{statusLabel}</span>
        {open ? <ChevronDown size={11} style={{ color: "var(--text-dim)", marginLeft: 2 }} /> : <ChevronRight size={11} style={{ color: "var(--text-dim)", marginLeft: 2 }} />}
      </button>
      {!open && preview && (
        <div className="part-tool-preview">{preview.slice(0, 260)}{preview.length > 260 ? "..." : ""}</div>
      )}
      {open && (
        <div className="part-tool-body">
          {body}
        </div>
      )}
    </div>
  );
}

// ── Reasoning part ─────────────────────────────────────────────────────────

function ReasoningPartView({ part }: { part: Extract<Part, { type: "reasoning" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="part-reasoning">
      <button className="part-reasoning-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        reasoning
      </button>
      {open && <div className="part-reasoning-body">{part.text}</div>}
    </div>
  );
}

// ── Patch part ─────────────────────────────────────────────────────────────

function PatchPartView({ part, defaultOpen = false }: { part: Extract<Part, { type: "patch" }>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <div className="part-tool">
      <button className="part-tool-header" onClick={() => setOpen((v) => !v)}>
        <FileEdit size={12} style={{ color: "var(--blue)" }} />
        <span className="tool-name-text">
          patch
          <span className="tool-title"> {part.files.length} file{part.files.length !== 1 ? "s" : ""}</span>
        </span>
        <span className="tool-badge completed">applied</span>
        {open ? <ChevronDown size={11} style={{ color: "var(--text-dim)", marginLeft: 2 }} /> : <ChevronRight size={11} style={{ color: "var(--text-dim)", marginLeft: 2 }} />}
      </button>
      {open && (
        <div className="part-tool-body">
          {part.files.join("\n")}
        </div>
      )}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────

export function PartView({
  part,
  isLast,
  running,
  defaultOpenActions = false,
}: {
  part: Part;
  isLast: boolean;
  running: boolean;
  defaultOpenActions?: boolean;
}) {
  if (part.type === "text") {
    const showCursor = isLast && running && part.text;
    return (
      <div className="part-text">
        {renderText((part as { text: string }).text)}
        {showCursor && <span className="stream-cursor" />}
      </div>
    );
  }

  if (part.type === "reasoning") {
    return <ReasoningPartView part={part as Extract<Part, { type: "reasoning" }>} />;
  }

  if (part.type === "tool") {
    return <ToolPartView part={part as Extract<Part, { type: "tool" }>} defaultOpen={defaultOpenActions} />;
  }

  if (part.type === "patch") {
    return <PatchPartView part={part as Extract<Part, { type: "patch" }>} defaultOpen={defaultOpenActions} />;
  }

  // step-start, step-finish, others — skip silently
  return null;
}
