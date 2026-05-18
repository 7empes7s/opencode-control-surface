import React, { useState, useEffect } from 'react';
import { Radar, Settings } from 'lucide-react';
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

const ScoutPage: React.FC = () => {
  const [scoutRuns, setScoutRuns] = useState<ScoutRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<ScoutRun | null>(null);
  const [scoutConfig, setScoutConfig] = useState<ScoutConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

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

  const getScoreColor = (score: number) => {
    if (score >= 0.8) return 'text-green-600';
    if (score >= 0.6) return 'text-yellow-600';
    return 'text-red-600';
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
            <div className="text-center py-4">Loading...</div>
          ) : scoutRuns.length === 0 ? (
            <div className="text-center py-4 text-gray-500">No scout runs found</div>
          ) : (
            <div className="space-y-3">
              {scoutRuns.map((run) => (
                <div
                  key={run.id}
                  className={`p-3 border rounded-lg cursor-pointer hover:bg-gray-50 ${
                    selectedRun?.id === run.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                  }`}
                  onClick={() => setSelectedRun(run)}
                >
                  <div className="flex justify-between items-center">
                    <span className="font-medium">Run {run.id}</span>
                    <Pill color={run.trigger === 'manual' ? 'blue' : 'gray'}>
                      {run.trigger}
                    </Pill>
                  </div>
                  <div className="text-sm text-gray-500">
                    {formatDate(run.runAt)} • {run.topics.filter(t => t.selected).length} selected
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
                  <span className="text-gray-500 italic">No stories queued</span>
                )}
              </div>
            </div>
            
            <div>
              <div className="w-label">Configuration Snapshot</div>
              <pre className="bg-gray-100 p-3 rounded text-xs overflow-x-auto mt-2">
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
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="w-label text-left">Topic</th>
                  <th className="w-label text-left">Vertical</th>
                  <th className="w-label text-left">Source</th>
                  <th className="w-label text-right">Recency</th>
                  <th className="w-label text-right">Novelty</th>
                  <th className="w-label text-right">Final Score</th>
                  <th className="w-label text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {selectedRun.topics.map((topic, index) => (
                  <tr key={index} className="border-b">
                    <td className="py-2">{topic.headline}</td>
                    <td>
                      <Pill color="blue">{topic.vertical}</Pill>
                    </td>
                    <td>{topic.source}</td>
                    <td className={`text-right ${getScoreColor(topic.recencyScore)}`}>
                      {(topic.recencyScore * 100).toFixed(0)}%
                    </td>
                    <td className={`text-right ${getScoreColor(topic.noveltyScore)}`}>
                      {(topic.noveltyScore * 100).toFixed(0)}%
                    </td>
                    <td className={`text-right ${getScoreColor(topic.finalScore)}`}>
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