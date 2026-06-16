import { useState, useEffect } from 'react';
import QuickTemplates from './QuickTemplates';
import ProjectPicker from './ProjectPicker';
import PrePlanningChat from './PrePlanningChat';
import type { DiscoveredProject } from './ProjectPicker';
import { authFetch } from '../../lib/authFetch';

interface IntakeFormProps {
  onCreate: (session: any) => void;
}

export default function IntakeForm({ onCreate }: IntakeFormProps) {
  const [form, setForm] = useState({
    name: '',
    description: '',
    specs: '',
    project_mode: 'new' as 'new' | 'existing',
  });
  const [selectedProject, setSelectedProject] = useState<DiscoveredProject | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [discoveredProjects, setDiscoveredProjects] = useState<DiscoveredProject[]>([]);

  // Pre-fetch projects so PrePlanningChat has them immediately
  useEffect(() => {
    authFetch('/api/brainstorm/preflight/discover')
      .then(r => r.json())
      .then((d: { projects: DiscoveredProject[] }) => setDiscoveredProjects(d.projects ?? []))
      .catch(() => {});
  }, []);

  const handleTemplateSelect = (t: { project_mode: 'new' | 'existing'; description: string; specs: string }) => {
    setForm(prev => ({ ...prev, project_mode: t.project_mode, description: t.description, specs: t.specs }));
    if (t.project_mode === 'new') setSelectedProject(null);
  };

  const handleProjectChange = (project: DiscoveredProject | null) => {
    setSelectedProject(project);
    setForm(prev => ({ ...prev, project_mode: project ? 'existing' : 'new' }));
  };

  const handleBriefGenerated = (brief: {
    name: string; description: string; specs: string;
    project_mode: 'new' | 'existing'; codebase_path?: string;
  }) => {
    setForm({ name: brief.name, description: brief.description, specs: brief.specs, project_mode: brief.project_mode });
    if (brief.project_mode === 'existing' && brief.codebase_path) {
      const p = discoveredProjects.find(p => p.path === brief.codebase_path);
      if (p) setSelectedProject(p);
    }
    setShowChat(false);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.description.trim()) {
      setError('Name and description are required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await authFetch('/api/brainstorm/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          codebase_path: selectedProject?.path ?? null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create session');
      }
      const session = await res.json();
      onCreate(session);
      setForm({ name: '', description: '', specs: '', project_mode: 'new' });
      setSelectedProject(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {showChat && (
        <PrePlanningChat
          onBriefGenerated={handleBriefGenerated}
          onClose={() => setShowChat(false)}
          projects={discoveredProjects}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Quick-start templates */}
        <QuickTemplates onSelect={handleTemplateSelect} />

        {/* Chat CTA */}
        <button
          onClick={() => setShowChat(true)}
          style={{
            background: 'transparent',
            border: '1px dashed var(--accent-dim)',
            borderRadius: 8,
            padding: '8px 14px',
            color: 'var(--accent)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'var(--sans)',
            marginBottom: 4,
            transition: 'border-color 0.15s, background 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'color-mix(in oklch, var(--accent) 8%, transparent)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
        >
          💬 Not sure what to build? Talk it through with AI →
        </button>

        {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}

        <div className="form-field">
          <label className="form-label">Feature Name</label>
          <input
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. User notifications, CSV export, Auth flow"
            className="form-input w-full"
            maxLength={100}
          />
        </div>

        {/* Project picker — shown when mode is existing */}
        {form.project_mode === 'existing' && (
          <ProjectPicker value={selectedProject} onChange={handleProjectChange} />
        )}

        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {(['new', 'existing'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => {
                setForm(prev => ({ ...prev, project_mode: mode }));
                if (mode === 'new') setSelectedProject(null);
              }}
              style={{
                background: form.project_mode === mode ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'var(--bg-raised)',
                border: `1px solid ${form.project_mode === mode ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6, padding: '4px 12px', fontSize: 11, fontWeight: 500,
                color: form.project_mode === mode ? 'var(--accent)' : 'var(--text-dim)',
                cursor: 'pointer', fontFamily: 'var(--sans)',
              }}
            >
              {mode === 'new' ? 'New project' : 'Existing project'}
            </button>
          ))}
        </div>

        <div className="form-field">
          <label className="form-label">Description</label>
          <textarea
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="What do you want to build and why? Be as detailed or rough as you like."
            className="form-input w-full"
            style={{ height: 100, resize: 'vertical' }}
            maxLength={2000}
          />
        </div>

        <div className="form-field">
          <label className="form-label">Specs (optional)</label>
          <textarea
            value={form.specs}
            onChange={e => setForm({ ...form, specs: e.target.value })}
            placeholder="Tech constraints, integrations, mobile/web, performance requirements…"
            className="form-input w-full"
            style={{ height: 72, resize: 'vertical' }}
            maxLength={1000}
          />
        </div>

        <button
          onClick={submit}
          disabled={loading}
          style={{
            background: loading ? 'var(--bg-raised)' : 'var(--accent)',
            color: 'var(--bg)',
            border: 'none', borderRadius: 6, padding: '8px 20px',
            fontSize: 13, fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.5 : 1,
            fontFamily: 'var(--sans)', alignSelf: 'flex-start',
          }}
        >
          {loading ? 'Creating…' : 'Start Planning'}
        </button>
      </div>
    </>
  );
}
