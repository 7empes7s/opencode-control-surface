interface Template {
  id: string;
  label: string;
  hint: string;
  project_mode: 'new' | 'existing';
  descriptionTemplate?: string;
  specsTemplate?: string;
}

const TEMPLATES: Template[] = [
  {
    id: 'add-existing',
    label: 'Add to existing project',
    hint: 'New feature, page, or service on top of existing code',
    project_mode: 'existing',
    descriptionTemplate: 'I want to add ',
  },
  {
    id: 'new-project',
    label: 'New project from scratch',
    hint: 'Greenfield — no existing codebase to worry about',
    project_mode: 'new',
    descriptionTemplate: '',
  },
  {
    id: 'new-api',
    label: 'New API / service',
    hint: 'Backend endpoint, microservice, or data pipeline',
    project_mode: 'new',
    specsTemplate: 'Backend service, REST API',
  },
  {
    id: 'new-ui',
    label: 'New UI page / screen',
    hint: 'Frontend page, dashboard view, or user flow',
    project_mode: 'new',
    specsTemplate: 'Frontend, React/TypeScript',
  },
];

interface QuickTemplatesProps {
  onSelect: (template: { project_mode: 'new' | 'existing'; description: string; specs: string }) => void;
}

export default function QuickTemplates({ onSelect }: QuickTemplatesProps) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
      {TEMPLATES.map(t => (
        <button
          key={t.id}
          onClick={() => onSelect({ project_mode: t.project_mode, description: t.descriptionTemplate ?? '', specs: t.specsTemplate ?? '' })}
          style={{
            background: 'var(--bg-raised)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 12px',
            textAlign: 'left',
            cursor: 'pointer',
            transition: 'border-color 0.15s, background 0.15s',
            fontFamily: 'var(--sans)',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent-dim)';
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-hover)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-raised)';
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 2 }}>{t.label}</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>{t.hint}</div>
        </button>
      ))}
    </div>
  );
}
