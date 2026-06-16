import { useState, useEffect } from 'react';
import { authFetch } from '../../lib/authFetch';

interface Pass {
  pass_number: number;
  role: string;
  response: string;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  created_at: number | null;
}

interface ResearchSource { title: string; url: string }
interface Research { context: string; sources: ResearchSource[] }

interface Detail {
  passes: Pass[];
  plans: { v1: string | null; v2: string | null; summary: string | null };
  research?: Research | null;
}

type PlanTab = 'v2' | 'v1' | 'summary';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export default function PlanDetail({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<PlanTab>('v2');
  const [openPass, setOpenPass] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/brainstorm/session/${sessionId}/detail`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (!cancelled) { setDetail(d as Detail); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const panel: React.CSSProperties = { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
  const docBox: React.CSSProperties = {
    maxHeight: 360, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    fontFamily: MONO, fontSize: 12, lineHeight: 1.5, color: 'var(--text-bright)',
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 12,
  };

  if (loading) return <div style={panel}><div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading plan…</div></div>;
  if (!detail) return <div style={panel}><div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No plan detail available.</div></div>;

  const plans = detail.plans;
  const tabs: Array<{ key: PlanTab; label: string }> = [
    { key: 'v2', label: 'Technical Plan (V2)' },
    { key: 'v1', label: 'Stakeholder Plan (V1)' },
    { key: 'summary', label: 'Summary' },
  ];
  const activeDoc = plans[tab];
  const fmtCost = (c: number | null) => (c == null ? '—' : `$${c.toFixed(4)}`);
  const fmtTok = (i: number | null, o: number | null) => `${i ?? '?'}/${o ?? '?'} tok`;

  const research = detail.research;

  return (
    <>
      {research && research.context && (
        <div style={panel}>
          <div className="dash-section-title" style={{ marginBottom: 10 }}>Web Research</div>
          <div style={docBox}>{research.context}</div>
          {research.sources.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>Sources ({research.sources.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {research.sources.map((s, i) => (
                  <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
                     style={{ fontSize: 12, color: 'var(--accent, #4ea1ff)', wordBreak: 'break-all' }}>
                    {s.title} — {s.url}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={panel}>
        <div className="dash-section-title" style={{ marginBottom: 10 }}>Plan Documents</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`btn btn-xs ${tab === t.key ? 'btn-primary' : 'btn-ghost'}`}
              disabled={!plans[t.key]}
              style={{ opacity: plans[t.key] ? 1 : 0.4 }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {activeDoc
          ? <div style={docBox}>{activeDoc}</div>
          : <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>This document was not generated.</div>}
      </div>

      <div style={panel}>
        <div className="dash-section-title" style={{ marginBottom: 10 }}>Planning Steps ({detail.passes.length})</div>
        {detail.passes.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No pass logs recorded.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {detail.passes.map(p => {
              const open = openPass === p.pass_number;
              return (
                <div key={p.pass_number} style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                  <button
                    onClick={() => setOpenPass(open ? null : p.pass_number)}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                  >
                    <span style={{ fontSize: 13, color: 'var(--text-bright)', fontWeight: 500 }}>{p.pass_number}. {p.role}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                      {p.model_used ?? '—'} · {fmtTok(p.input_tokens, p.output_tokens)} · {fmtCost(p.cost)} {open ? '▾' : '▸'}
                    </span>
                  </button>
                  {open && (
                    <div style={{ ...docBox, maxHeight: 300, borderRadius: 0, border: 'none', borderTop: '1px solid var(--border)' }}>{p.response}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
