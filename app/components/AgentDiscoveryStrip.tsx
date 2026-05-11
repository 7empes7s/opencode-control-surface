import { useEffect, useMemo, useState } from "react";
import { Boxes, PlugZap, TerminalSquare } from "lucide-react";

type AgentId = "claude" | "codex" | "opencode";
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

export function AgentDiscoveryStrip({ agent }: { agent: AgentId }) {
  const [data, setData] = useState<DiscoveryData | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="agent-discovery-strip">
      <div className="agent-discovery-group">
        <span className={`agent-status-dot ${statusClass(cliStatus)}`} />
        <TerminalSquare size={13} />
        <span className="agent-discovery-label">{versionText(agent, data)}</span>
      </div>
      <div className="agent-discovery-group">
        <Boxes size={13} />
        <span>{data ? counts.skills : "..."}</span>
        <span className="agent-discovery-muted">skills</span>
      </div>
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
  );
}
