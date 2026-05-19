import React, { useState, useEffect } from 'react';
import { Radar, Settings } from 'lucide-react';
import { TableControls } from '../components/TableControls';
import { useTableControls } from '../hooks/useTableControls';
import { authFetch } from '../lib/authFetch';

interface ScoutTopic {
  headline: string;
  vertical: string;
  source: string;
  recencyScore: number;
  noveltyScore: number;
  finalScore: number;
  selected: boolean;
  reason: string;
}

interface ScoutRun {
  id: string;
  runAt: string;
  trigger: string;
  topics: ScoutTopic[];
  queued: string[];
  config: Record<string, any>;
}

interface ScoutConfig {
  enabled: boolean;
  frequency: string;
  verticals: string[];
  maxTopicsPerRun: number;
  minNoveltyScore: number;
  minRecencyHours: number;
  autoQueueThreshold: number;
}

function WCard({ children, className = "", style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`w-card ${className}`} style={style}>{children}</div>;
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: "green" | "red" | "amber" | "gray" | "blue" }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

export type TopicsSortKey = "finalScore" | "vertical" | "source" | "recencyScore" | "noveltyScore";

const ScoutPage: React.FC = () => {
  const [scoutRuns, setScoutRuns] = useState<ScoutRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<ScoutRun | null>(null);
  const [scoutConfig, setScoutConfig] = useState<ScoutConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  const topicsCtrl = useTableControls<ScoutTopic, TopicsSortKey>({
    rows: selectedRun?.topics ?? [],
    pageSize: 25,
    filterText: (row) => [row.headline, row.vertical, row.source, row.reason].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "finalScore": return row.finalScore ?? 0;
        case "vertical": return row.vertical ?? "";
        case "source": return row.source ?? "";
        case "recencyScore": return row.recencyScore ?? 0;
        case "noveltyScore": return row.noveltyScore ?? 0;
        default: return "";
      }
    },
    defaultSort: { key: "finalScore", dir: "desc" },
  });

  // Load scout runs and config
  useEffect(() => {
    loadScoutData();
  }, []);

  const loadScoutData = async () => {
    try {
      setIsLoading(true);
      
      // Load scout runs
      const runsResponse = await authFetch('/api/scout/runs');
      if (runsResponse.ok) {
        const runsData = await runsResponse.json();
        const runs = runsData.data?.runs ?? runsData.runs ?? [];
        setScoutRuns(runs);
        if (runs.length > 0) {
          setSelectedRun(runs[0]);
        }
      }

      // Load scout config
      const configResponse = await authFetch('/api/scout/config');
      if (configResponse.ok) {
        const configData = await configResponse.json();
        setScoutConfig(configData.data ?? configData);
      }
    } catch (error) {
      console.error('Error loading scout data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRunScout = async () => {
    // This would typically trigger a scout run via the API
    console.log('Running manual scout...');
    // In a real implementation: await fetch('/api/autopipeline/command', { method: 'POST', body: JSON.stringify({cmd: 'run_scout'}) })
  };

  const handleSaveConfig = async () => {
    if (!scoutConfig) return;
    
    try {
      setIsSavingConfig(true);
      const response = await authFetch('/api/scout/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scoutConfig)
      });
      
      if (response.ok) {
        console.log('Scout config saved successfully');
      }
    } catch (error) {
      console.error('Error saving scout config:', error);
    } finally {
      setIsSavingConfig(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getScoreStyle = (score: number): React.CSSProperties => {
    if (score >= 0.8) return { color: "var(--color-green, #4ade80)" };
    if (score >= 0.6) return { color: "var(--color-amber, #fbbf24)" };
    return { color: "var(--color-red, #f87171)" };
  };

  return (
    <div className="dash-page">
      <div className="dash-section">
        <div className="dash-section-title flex items-center gap-3">
          <Radar className="h-5 w-5 text-blue-600" />
          <span>Scout Transparency</span>
        </div>
        <div className="w-caption">Monitor and configure the story scouting process</div>
      </div>

      <div className="dash-section">
        <div className="dash-section-title">Statistics</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <WCard>
            <div className="w-row">
              <span className="w-label">Total Runs</span>
              <span className="w-value">{scoutRuns.length}</span>
            </div>
          </WCard>
          <WCard>
            <div className="w-row">
              <span className="w-label">Last Run</span>
              <span className="w-value">
                {scoutRuns.length > 0 ? formatDate(scoutRuns[0].runAt) : 'N/A'}
              </span>
            </div>
          </WCard>
          <WCard>
            <div className="w-row">
              <span className="w-label">Selected Topics</span>
              <span className="w-value">
                {scoutRuns.reduce((acc, run) => acc + run.topics.filter(t => t.selected).length, 0)}
              </span>
            </div>
          </WCard>
          <WCard>
            <div className="w-row">
              <span className="w-label">Queued Stories</span>
              <span className="w-value">
                {scoutRuns.reduce((acc, run) => acc + run.queued.length, 0)}
              </span>
            </div>
          </WCard>
        </div>
      </div>

      <div className="dash-section">
        <div className="flex justify-between items-center">
          <div className="dash-section-title">Scout Run History</div>
          <button className="btn-secondary" onClick={handleRunScout}>
            Run Now
          </button>
        </div>
        <div className="w-card">
          {isLoading ? (
            <div className="loading-dim">loading…</div>
          ) : scoutRuns.length === 0 ? (
            <div className="loading-dim">no scout runs found</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {scoutRuns.map((run) => (
                <div
                  key={run.id}
                  style={{
                    padding: "8px 12px",
                    border: `1px solid ${selectedRun?.id === run.id ? "var(--accent)" : "var(--border)"}`,
                    borderRadius: 6,
                    cursor: "pointer",
                    background: selectedRun?.id === run.id ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent",
                  }}
                  onClick={() => setSelectedRun(run)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>Run {run.id}</span>
                    <Pill color={run.trigger === 'manual' ? 'blue' : 'gray'}>
                      {run.trigger}
                    </Pill>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                    {formatDate(run.runAt)} · {run.topics.filter(t => t.selected).length} selected
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedRun && (
        <div className="dash-section">
          <div className="dash-section-title">Run Details: {selectedRun.id}</div>
          <WCard>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <div className="w-label">Run Time</div>
                <div>{formatDate(selectedRun.runAt)}</div>
              </div>
              <div>
                <div className="w-label">Trigger</div>
                <div>{selectedRun.trigger}</div>
              </div>
              <div>
                <div className="w-label">Total Topics</div>
                <div>{selectedRun.topics.length}</div>
              </div>
              <div>
                <div className="w-label">Selected Topics</div>
                <div>{selectedRun.topics.filter(t => t.selected).length}</div>
              </div>
            </div>
            
            <div className="mb-4">
              <div className="w-label">Queued Stories</div>
              <div className="flex flex-wrap gap-2 mt-1">
                {selectedRun.queued.length > 0 ? (
                  selectedRun.queued.map((slug, idx) => (
                    <Pill key={idx} color="blue">{slug}</Pill>
                  ))
                ) : (
                  <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>No stories queued</span>
                )}
              </div>
            </div>
            
            <div>
              <div className="w-label">Configuration Snapshot</div>
              <pre style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: "8px 12px", borderRadius: 4, fontSize: 11, overflowX: "auto", marginTop: 6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>
                {JSON.stringify(selectedRun.config, null, 2)}
              </pre>
            </div>
          </WCard>
        </div>
      )}

      {selectedRun && (
        <div className="dash-section">
          <div className="dash-section-title">Ranked Topics</div>
          <WCard>
            <TableControls {...topicsCtrl.controlsProps} searchPlaceholder="Search topics..." />
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="w-label text-left">Topic</th>
                  <th {...topicsCtrl.sortHeaderProps("vertical")} className="w-label text-left">Vertical <span className="sortable-th-arrow">{topicsCtrl.sort.key === "vertical" ? (topicsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...topicsCtrl.sortHeaderProps("source")} className="w-label text-left">Source <span className="sortable-th-arrow">{topicsCtrl.sort.key === "source" ? (topicsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...topicsCtrl.sortHeaderProps("recencyScore")} className="w-label text-right">Recency <span className="sortable-th-arrow">{topicsCtrl.sort.key === "recencyScore" ? (topicsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...topicsCtrl.sortHeaderProps("noveltyScore")} className="w-label text-right">Novelty <span className="sortable-th-arrow">{topicsCtrl.sort.key === "noveltyScore" ? (topicsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...topicsCtrl.sortHeaderProps("finalScore")} className="w-label text-right">Final Score <span className="sortable-th-arrow">{topicsCtrl.sort.key === "finalScore" ? (topicsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th className="w-label text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {topicsCtrl.rows.map((topic, index) => (
                  <tr key={index} className="border-b">
                    <td className="py-2">{topic.headline}</td>
                    <td>
                      <Pill color="blue">{topic.vertical}</Pill>
                    </td>
                    <td>{topic.source}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)", ...getScoreStyle(topic.recencyScore) }}>
                      {(topic.recencyScore * 100).toFixed(0)}%
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)", ...getScoreStyle(topic.noveltyScore) }}>
                      {(topic.noveltyScore * 100).toFixed(0)}%
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)", ...getScoreStyle(topic.finalScore) }}>
                      {(topic.finalScore * 100).toFixed(0)}%
                    </td>
                    <td>
                      {topic.selected ? (
                        <Pill color="green">Selected</Pill>
                      ) : (
                        <Pill color="gray">Skipped</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </WCard>
        </div>
      )}

      {scoutConfig && (
        <div className="dash-section">
          <div className="dash-section-title flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Scout Configuration
          </div>
          <WCard>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div>
                <label className="w-label block mb-1">Enabled</label>
                <input
                  type="checkbox"
                  checked={scoutConfig.enabled}
                  onChange={(e) => setScoutConfig({...scoutConfig, enabled: e.target.checked})}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
              </div>
              <div>
                <label className="w-label block mb-1">Frequency</label>
                <input
                  type="text"
                  value={scoutConfig.frequency}
                  onChange={(e) => setScoutConfig({...scoutConfig, frequency: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                />
              </div>
              <div>
                <label className="w-label block mb-1">Max Topics Per Run</label>
                <input
                  type="number"
                  value={scoutConfig.maxTopicsPerRun}
                  onChange={(e) => setScoutConfig({...scoutConfig, maxTopicsPerRun: Number(e.target.value)})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                />
              </div>
              <div>
                <label className="w-label block mb-1">Minimum Novelty Score</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={scoutConfig.minNoveltyScore}
                  onChange={(e) => setScoutConfig({...scoutConfig, minNoveltyScore: Number(e.target.value)})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                />
              </div>
              <div>
                <label className="w-label block mb-1">Minimum Recency Hours</label>
                <input
                  type="number"
                  value={scoutConfig.minRecencyHours}
                  onChange={(e) => setScoutConfig({...scoutConfig, minRecencyHours: Number(e.target.value)})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                />
              </div>
              <div>
                <label className="w-label block mb-1">Auto Queue Threshold</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={scoutConfig.autoQueueThreshold}
                  onChange={(e) => setScoutConfig({...scoutConfig, autoQueueThreshold: Number(e.target.value)})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                />
              </div>
            </div>
            
            <div className="mb-4">
              <label className="w-label block mb-1">Verticals</label>
              <div className="flex flex-wrap gap-2">
                {scoutConfig.verticals.map((vertical, index) => (
                  <Pill key={index} color="blue">{vertical}</Pill>
                ))}
              </div>
            </div>
            
            <div className="flex justify-end">
              <button className="btn-primary" onClick={handleSaveConfig} disabled={isSavingConfig}>
                {isSavingConfig ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </WCard>
        </div>
      )}
    </div>
  );
};

export default ScoutPage;