import { useState, useEffect } from 'react';
import { authFetch } from '../../lib/authFetch';

export interface DiscoveredProject {
  name: string;
  path: string;
  tech: string[];
  description: string;
  lastCommit: string | null;
}

interface ProjectPickerProps {
  value: DiscoveredProject | null;
  onChange: (project: DiscoveredProject | null) => void;
}

export default function ProjectPicker({ value, onChange }: ProjectPickerProps) {
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch('/api/brainstorm/preflight/discover')
      .then(r => r.json())
      .then((d: { projects: DiscoveredProject[] }) => setProjects(d.projects ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="form-field">
      <label className="form-label">Project</label>
      <select
        className="form-input w-full"
        style={{ fontFamily: 'var(--sans)' }}
        value={value?.path ?? ''}
        onChange={e => {
          const p = projects.find(p => p.path === e.target.value) ?? null;
          onChange(p);
        }}
      >
        <option value="">{loading ? 'Scanning projects…' : 'Select a project…'}</option>
        {projects.map(p => (
          <option key={p.path} value={p.path}>
            {p.name}{p.tech.length ? ` (${p.tech.slice(0, 3).join(', ')})` : ''}
          </option>
        ))}
      </select>
      {value && (
        <div style={{ marginTop: 6, padding: '6px 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 2 }}>{value.path}</div>
          {value.description && <div style={{ fontSize: 12, color: 'var(--text)' }}>{value.description}</div>}
          {value.tech.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
              {value.tech.map(t => <span key={t} className="pill gray" style={{ fontSize: 10 }}>{t}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
