import type { AgentRun } from "../../server/api/types";

interface AgentRunListProps {
  agentRuns: AgentRun[];
}

export function AgentRunList({ agentRuns }: AgentRunListProps) {
  if (agentRuns.length === 0) {
    return <div className="loading-dim">No agent runs found</div>;
  }
  
  return (
    <div className="timeline">
      {agentRuns.map((run) => (
        <div key={run.id} className="timeline-item">
          <div className="timeline-badge">
            <div className="badge">{run.stage}</div>
          </div>
          <div className="timeline-content">
            <div className="timeline-header">
              <span className="mono">{run.startedAt}</span>
              <span className="dim">ID: {run.id}</span>
            </div>
            <div className="timeline-body">
              <details>
                <summary>Metadata</summary>
                <pre className="code-block">{JSON.stringify(run.metadata, null, 2)}</pre>
              </details>
              <details>
                <summary>Response</summary>
                <pre className="code-block">{JSON.stringify(run.response, null, 2)}</pre>
              </details>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}