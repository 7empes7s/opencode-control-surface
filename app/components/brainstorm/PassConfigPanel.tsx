import { useState } from 'react';
import { authFetch } from '../../lib/authFetch';

function SmartRecommendationOverlay({ descriptionLength }: { descriptionLength: number }) {
  const complexity = Math.min(1, descriptionLength / 500);
  const recommended = Math.max(3, Math.min(8, Math.round(3 + complexity * 5)));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Recommended passes based on complexity:</span>
      <span className="pill blue">{recommended}</span>
    </div>
  );
}

interface Session {
  id: string;
  description?: string;
  recommended_passes?: number;
}

interface PassConfigPanelProps {
  session: Session;
  onStart: () => void;
}

export default function PassConfigPanel({ session, onStart }: PassConfigPanelProps) {
  const [passes, setPasses] = useState(session.recommended_passes ?? 6);
  const [loading, setLoading] = useState(false);

  const save = async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/brainstorm/session/${session.id}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_passes: passes })
      });
      if (!res.ok) throw new Error('Failed to save config');
      onStart();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SmartRecommendationOverlay descriptionLength={session.description?.length ?? 0} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <label style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap' }}>Passes: <span style={{ color: 'var(--text-bright)', fontWeight: 600 }}>{passes}</span></label>
        <input
          type="range"
          min="3"
          max="8"
          value={passes}
          onChange={e => setPasses(+e.target.value)}
          style={{ flex: 1, accentColor: 'var(--accent)' }}
        />
      </div>
      <button
        onClick={save}
        disabled={loading}
        style={{
          background: loading ? 'var(--bg-raised)' : 'var(--accent)',
          color: 'var(--bg)',
          border: 'none',
          borderRadius: 6,
          padding: '7px 18px',
          fontSize: 13,
          fontWeight: 600,
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.5 : 1,
          fontFamily: 'var(--sans)',
          alignSelf: 'flex-start'
        }}
      >
        {loading ? 'Starting...' : 'Start Brainstorming'}
      </button>
    </div>
  );
}
