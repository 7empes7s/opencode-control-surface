export type TranscriptMode = "all" | "actions" | "messages";
export type ActionFilter = "all" | "errored" | "edits" | "deletes" | "commands" | "reads" | "web" | "other";

type TranscriptCounts = {
  messages: number;
  actions: number;
  thoughts: number;
  errored: number;
  edits: number;
  deletes: number;
};

const MODES: Array<{ id: TranscriptMode; label: string; title: string }> = [
  { id: "all", label: "all", title: "Show messages, actions, and reasoning" },
  { id: "actions", label: "actions", title: "Show tool calls, edits, commands, and results" },
  { id: "messages", label: "messages", title: "Show chat messages only" },
];

const ACTION_FILTERS: Array<{ id: ActionFilter; label: string }> = [
  { id: "all", label: "all actions" },
  { id: "errored", label: "errored" },
  { id: "edits", label: "edits" },
  { id: "deletes", label: "deletes" },
  { id: "commands", label: "commands" },
  { id: "reads", label: "reads" },
  { id: "web", label: "web" },
  { id: "other", label: "other" },
];

export function TranscriptControls({
  mode,
  actionFilter,
  counts,
  onModeChange,
  onActionFilterChange,
}: {
  mode: TranscriptMode;
  actionFilter: ActionFilter;
  counts: TranscriptCounts;
  onModeChange: (mode: TranscriptMode) => void;
  onActionFilterChange: (filter: ActionFilter) => void;
}) {
  return (
    <div className="transcript-controls" aria-label="Transcript visibility controls">
      <div className="transcript-mode-group">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`transcript-chip${mode === item.id ? " active" : ""}`}
            onClick={() => onModeChange(item.id)}
            title={item.title}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="transcript-counts" aria-label="Transcript counts">
        <span>{counts.messages} msg</span>
        <span>{counts.actions} actions</span>
        <span>{counts.thoughts} thoughts</span>
        {counts.errored > 0 && <span className="danger">{counts.errored} errors</span>}
        {counts.edits > 0 && <span>{counts.edits} edits</span>}
        {counts.deletes > 0 && <span className="danger">{counts.deletes} deletes</span>}
      </div>

      {mode === "actions" && (
        <div className="transcript-action-filters">
          {ACTION_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`transcript-chip small${actionFilter === item.id ? " active" : ""}`}
              onClick={() => onActionFilterChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
