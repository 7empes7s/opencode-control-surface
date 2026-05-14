import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Boxes, ChevronRight, PlugZap, Search, TerminalSquare, X } from "lucide-react";

type AgentId = "claude" | "codex" | "opencode" | "gemini";
type DiscoveryStatus = "ok" | "missing" | "degraded" | "error";

type SkillItem = {
  name: string;
  description: string;
  source: string;
  sourcePath: string;
  agents: AgentId[];
};

type CommandItem = {
  name: string;
  description: string;
  source: string;
  agents: AgentId[];
};

type DiscoveryData = {
  generatedAt: string;
  counts?: Record<AgentId, { skills: number; commands: number; sessions: number }>;
  skills?: SkillItem[];
  commands?: CommandItem[];
  cli: Record<AgentId, { status: DiscoveryStatus; stdout?: string; evidence: string }>;
  mcp: Record<AgentId, { status: DiscoveryStatus; evidence: string }>;
  runtime: {
    claudeSessions: { count: number };
    codexSessions: { count: number };
    opencodeSessions: { count: number; status: DiscoveryStatus };
    opencodeAgents: { count: number; names: string[]; status: DiscoveryStatus };
    opencodeModels: { sample: string[]; status: DiscoveryStatus };
    geminiSessions: { count: number };
  };
};

function statusClass(status: DiscoveryStatus | undefined): string {
  if (status === "ok") return "ok";
  if (status === "missing") return "missing";
  return "warn";
}

function versionText(agent: AgentId, data: DiscoveryData | null): string {
  const raw = data?.cli[agent]?.stdout?.trim();
  if (!raw) return data?.cli[agent]?.status ?? "checking";
  return raw.split(/\r?\n/)[0].slice(0, 42);
}

function SkillsBrowser({
  agent,
  data,
  onInsert,
  onClose,
}: {
  agent: AgentId;
  data: DiscoveryData;
  onInsert?: (text: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const skills = useMemo(() => {
    const all = (data.skills ?? []).filter((s) => s.agents.includes(agent));
    if (!query.trim()) return all;
    const q = query.toLowerCase();
    return all.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.source.toLowerCase().includes(q),
    );
  }, [data, agent, query]);

  const commands = useMemo(() => {
    const all = (data.commands ?? []).filter((c) => c.agents.includes(agent));
    if (!query.trim()) return all;
    const q = query.toLowerCase();
    return all.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q),
    );
  }, [data, agent, query]);

  const modal = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="skills-browser" onClick={(e) => e.stopPropagation()}>
        <div className="skills-browser-head">
          <Search size={13} className="skills-browser-search-icon" />
          <input
            ref={inputRef}
            className="skills-browser-input"
            placeholder="Search skills and commands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="oc-icon-btn" style={{ flexShrink: 0 }} onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="skills-browser-body">
          {skills.length > 0 && (
            <div className="skills-browser-section">
              <div className="skills-browser-section-label">skills ({skills.length})</div>
              {skills.map((s) => (
                <button
                  key={`${s.source}:${s.name}`}
                  type="button"
                  className="skills-browser-item"
                  onClick={() => {
                    onInsert?.(`/${s.name} `);
                    onClose();
                  }}
                >
                  <span className="skills-browser-item-name">/{s.name}</span>
                  <span className="skills-browser-item-desc">{s.description}</span>
                  <span className="skills-browser-item-source">{s.source}</span>
                  {onInsert && <ChevronRight size={11} className="skills-browser-item-arrow" />}
                </button>
              ))}
            </div>
          )}

          {commands.length > 0 && (
            <div className="skills-browser-section">
              <div className="skills-browser-section-label">commands ({commands.length})</div>
              {commands.map((c) => (
                <button
                  key={`${c.source}:${c.name}`}
                  type="button"
                  className="skills-browser-item"
                  onClick={() => {
                    onInsert?.(`/${c.name} `);
                    onClose();
                  }}
                >
                  <span className="skills-browser-item-name">/{c.name}</span>
                  <span className="skills-browser-item-desc">{c.description}</span>
                  <span className="skills-browser-item-source">{c.source}</span>
                  {onInsert && <ChevronRight size={11} className="skills-browser-item-arrow" />}
                </button>
              ))}
            </div>
          )}

          {skills.length === 0 && commands.length === 0 && (
            <div className="skills-browser-empty">
              {query ? `No matches for "${query}"` : "No skills or commands found for this agent."}
            </div>
          )}
        </div>

        {!onInsert && (
          <div className="skills-browser-hint">
            Type <code>/skill-name</code> in the composer to invoke a skill.
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

export function AgentDiscoveryStrip({
  agent,
  onInsert,
}: {
  agent: AgentId;
  onInsert?: (text: string) => void;
}) {
  const [data, setData] = useState<DiscoveryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agents/summary")
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json() as Promise<DiscoveryData>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, []);

  const counts = useMemo(() => {
    if (data?.counts?.[agent]) return data.counts[agent];
    const skills = data?.skills?.filter((item) => item.agents.includes(agent)).length ?? 0;
    const commands = data?.commands?.filter((item) => item.agents.includes(agent)).length ?? 0;
    const sessions =
      agent === "claude" ? data?.runtime.claudeSessions.count :
      agent === "codex" ? data?.runtime.codexSessions.count :
      agent === "gemini" ? data?.runtime.geminiSessions.count :
      data?.runtime.opencodeSessions.count;
    return { skills, commands, sessions: sessions ?? 0 };
  }, [agent, data]);

  const cliStatus = data?.cli[agent]?.status;
  const mcpStatus = data?.mcp[agent]?.status;

  if (error) {
    return (
      <div className="agent-discovery-strip error">
        <span className="agent-discovery-label">catalog unavailable</span>
        <span className="agent-discovery-detail">{error.slice(0, 160)}</span>
      </div>
    );
  }

  return (
    <>
      <div className="agent-discovery-strip">
        <div className="agent-discovery-group">
          <span className={`agent-status-dot ${statusClass(cliStatus)}`} />
          <TerminalSquare size={13} />
          <span className="agent-discovery-label">{versionText(agent, data)}</span>
        </div>
        <button
          type="button"
          className={`agent-discovery-group agent-discovery-skills-btn${browserOpen ? " active" : ""}`}
          onClick={() => setBrowserOpen(true)}
          title="Browse skills"
          disabled={!data}
        >
          <Boxes size={13} />
          <span>{data ? counts.skills : "..."}</span>
          <span className="agent-discovery-muted">skills</span>
        </button>
        <div className="agent-discovery-group">
          <span>{data ? counts.commands : "..."}</span>
          <span className="agent-discovery-muted">commands</span>
        </div>
        <div className="agent-discovery-group">
          <span>{data ? counts.sessions : "..."}</span>
          <span className="agent-discovery-muted">sessions</span>
        </div>
        <div className="agent-discovery-group">
          <span className={`agent-status-dot ${statusClass(mcpStatus)}`} />
          <PlugZap size={13} />
          <span className="agent-discovery-muted">mcp</span>
        </div>
        {agent === "opencode" && data && (
          <div className="agent-discovery-group wide">
            <span>{data.runtime.opencodeAgents.count}</span>
            <span className="agent-discovery-muted">agents</span>
            {data.runtime.opencodeAgents.names.slice(0, 3).map((name) => (
              <span key={name} className="agent-mini-chip">{name}</span>
            ))}
          </div>
        )}
      </div>

      {browserOpen && data && (
        <SkillsBrowser
          agent={agent}
          data={data}
          onInsert={onInsert}
          onClose={() => setBrowserOpen(false)}
        />
      )}
    </>
  );
}
