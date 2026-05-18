import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { Link } from "wouter";
import type { MissionControlData } from "../../server/api/missionControl";

interface PriorityItem {
  id: string;
  title: string;
  description: string;
  severity: "info" | "warn" | "critical";
  sourceRoute?: string;
  action?: string;
  ageMs?: number;
}

function PriorityCard({ item }: { item: PriorityItem }) {
  const severityColor = 
    item.severity === "critical" ? "red" : 
    item.severity === "warn" ? "amber" : "gray";

  return (
    <div className="w-card" style={{ marginBottom: 8, padding: "12px" }}>
      <div className="w-row">
        <span className={`pill ${severityColor}`} style={{ fontSize: 10, marginRight: 8 }}>
          {item.severity}
        </span>
        <span className="w-headline xs" style={{ flex: 1 }}>
          {item.title}
        </span>
        {item.sourceRoute && (
          <Link href={item.sourceRoute} className="btn btn-ghost btn-xs">
            → Go
          </Link>
        )}
      </div>
      <div className="w-caption" style={{ marginTop: 4 }}>
        {item.description}
      </div>
      {item.ageMs && (
        <div className="w-caption dim" style={{ marginTop: 2, fontSize: 10 }}>
          {Math.round(item.ageMs / 60000)}m ago
        </div>
      )}
    </div>
  );
}

export function PriorityDeck() {
  const { data, loading, error } = useApi<MissionControlData>("/api/mission-control", 30_000);
  const [expanded, setExpanded] = useState(false);

  if (loading && !data) return <div className="loading-dim">loading priorities…</div>;
  if (error && !data) return <div className="loading-dim error">failed to load priorities</div>;
  if (!data) return null;

  const priorityItems: PriorityItem[] = data.decisionQueue.map(item => ({
    id: item.id,
    title: item.title,
    description: item.description,
    severity: item.severity,
    sourceRoute: item.sourceRoute,
    action: item.action,
    ageMs: item.ageMs
  }));

  // Limit to 3 items initially, show all when expanded
  const visibleItems = expanded ? priorityItems : priorityItems.slice(0, 3);

  return (
    <div className="dash-section">
      <div className="dash-section-title">
        priority deck
        {priorityItems.length > 3 && (
          <button 
            className="btn btn-ghost btn-xs" 
            onClick={() => setExpanded(!expanded)}
            style={{ float: "right", fontSize: 11 }}
          >
            {expanded ? "Show less" : `Show all (${priorityItems.length})`}
          </button>
        )}
      </div>
      
      {visibleItems.length > 0 ? (
        visibleItems.map(item => (
          <PriorityCard key={item.id} item={item} />
        ))
      ) : (
        <div className="w-card" style={{ padding: "12px", textAlign: "center" }}>
          <div className="w-caption">No immediate priorities</div>
          <div className="w-caption dim" style={{ marginTop: 4 }}>
            Everything looks good!
          </div>
        </div>
      )}
    </div>
  );
}