import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Menu, X } from 'lucide-react';
import IntakeForm from '../components/brainstorm/IntakeForm';
import PassConfigPanel from '../components/brainstorm/PassConfigPanel';
import PassTimeline from '../components/brainstorm/PassTimeline';
import PlanDetail from '../components/brainstorm/PlanDetail';
import UserMessageInput from '../components/brainstorm/UserMessageInput';
import { Reveal } from '../components/v5/ui';
import { authFetch } from '../lib/authFetch';

interface Session {
  id: string;
  name: string;
  description: string;
  status: string;
  target_passes: number;
  completed_passes: number;
  specs?: string;
  recommended_passes?: number;
  plan_v1_path?: string;
  plan_v2_path?: string;
  summary_path?: string;
}

interface BrainstormEvent {
  type: string;
  seq?: number;
  role?: string;
  status?: string;
  message?: string;
}

/** ≤900px → left column (new session + list) collapses behind a toggle. */
function useMobileDrawer() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 900px)').matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

function statusPillClass(status: string): string {
  if (status === 'done') return 'v5-pill ok';
  if (status === 'running') return 'v5-pill info';
  if (status === 'failed') return 'v5-pill err';
  if (status === 'paused' || status === 'canceled') return 'v5-pill warn';
  return 'v5-pill';
}

export default function BrainstormPage() {
  const [, navigate] = useLocation();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<BrainstormEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const isMobile = useMobileDrawer();
  const [panelOpen, setPanelOpen] = useState(() =>
    typeof window !== 'undefined' ? !window.matchMedia('(max-width: 900px)').matches : true
  );

  const fetchSessions = useCallback(async () => {
    try {
      const res = await authFetch('/api/brainstorm/sessions');
      if (res.ok) setSessions(await res.json());
    } catch (err) {
      console.error('Failed to fetch sessions', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const pollSession = useCallback(async (sessionId: string) => {
    try {
      const res = await authFetch(`/api/brainstorm/session/${sessionId}`);
      if (res.ok) {
        const session = await res.json();
        setCurrentSession(session);
        return !['done', 'failed', 'canceled'].includes(session.status);
      }
    } catch { /* ignore */ }
    return true;
  }, []);

  // SSE — open when session is running, close when done/error
  useEffect(() => {
    if (currentSession?.status !== 'running') return;
    const es = new EventSource(`/api/brainstorm/stream?sessionId=${currentSession.id}`);

    es.onmessage = (event) => {
      const data: BrainstormEvent = JSON.parse(event.data);
      setEvents(prev => [...prev, data]);
      if (data.type === 'pass_update') {
        pollSession(currentSession.id);
      }
      if (data.type === 'done' || data.type === 'error') {
        es.close();
        pollSession(currentSession.id);
        fetchSessions();
      }
    };

    es.onerror = () => es.close();

    return () => es.close();
  }, [currentSession?.id, currentSession?.status, pollSession, fetchSessions]);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  const handleCreate = (session: Session) => {
    setCurrentSession(session);
    setSessions(prev => [session, ...prev]);
  };

  const handleStart = async () => {
    if (!currentSession) return;
    try {
      const res = await authFetch(`/api/brainstorm/session/${currentSession.id}/start`, {
        method: 'POST',
      });
      if (res.ok) {
        setCurrentSession(prev => prev ? { ...prev, status: 'running' } : null);
        setEvents([]);
      }
    } catch (err) {
      console.error('Failed to start session', err);
    }
  };

  const handleCreateWorkflow = async () => {
    if (!currentSession) return;
    try {
      const res = await authFetch(`/api/brainstorm/session/${currentSession.id}/workflow`, {
        method: 'POST',
      });
      if (res.ok) {
        navigate('/builder');
        return;
      }
      const detail = await res.json().catch(() => ({} as { error?: string }));
      alert(`Couldn't create the workflow (${res.status}): ${detail?.error ?? 'unknown error'}`);
    } catch (err) {
      console.error('Failed to create workflow', err);
      alert(`Couldn't create the workflow: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const selectSession = (session: Session) => {
    setCurrentSession(session);
    setEvents([]);
    if (isMobile) setPanelOpen(false);
  };

  if (loading) return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 }}>
      <div className="v5-skeleton" style={{ height: 34, width: '42%' }} />
      <div className="v5-skeleton" style={{ height: 120 }} />
      <div className="v5-skeleton" style={{ height: 120 }} />
    </div>
  );

  return (
    <div className="brainstorm-page">
      <div className="v5-pagehead" style={{ marginBottom: 0 }}>
        <div className="v5-pagehead-row">
          <div>
            <div className="v5-pagehead-title">Brainstorm</div>
            <div className="v5-pagehead-sub">
              Multi-pass planning sessions that converge on a buildable spec, then hand off to Builder.
            </div>
          </div>
          {isMobile && (
            <button className="v5-btn" onClick={() => setPanelOpen(v => !v)}>
              {panelOpen ? <X size={15} /> : <Menu size={15} />}
              {panelOpen ? 'Hide panel' : 'Sessions'}
            </button>
          )}
        </div>
      </div>

      <div className="brainstorm-cols">
        {/* Left column */}
        {(!isMobile || panelOpen) && (
          <div className="brainstorm-col-left">
            <Reveal delay={0.02}>
              <div className="v5-card glass flat-hover">
                <div className="v5-card-label">New Brainstorm</div>
                <IntakeForm onCreate={handleCreate} />
              </div>
            </Reveal>

            <Reveal delay={0.06}>
              <div className="v5-card glass flat-hover">
                <div className="v5-card-label">Recent Sessions</div>
                {sessions.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No sessions yet — start one above.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {sessions.map(session => {
                      const isActive = currentSession?.id === session.id;
                      return (
                        <button
                          key={session.id}
                          onClick={() => selectSession(session)}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            padding: '10px 12px',
                            borderRadius: 'var(--r-md)',
                            border: isActive ? '1px solid var(--border-glow)' : '1px solid var(--border)',
                            background: isActive ? 'var(--grad-accent-soft)' : 'var(--bg-sub)',
                            cursor: 'pointer',
                            transition: 'background 0.15s, border-color 0.15s',
                          }}
                          onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-hover)'; }}
                          onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-sub)'; }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {session.name}
                            </span>
                            <span className={statusPillClass(session.status)} style={{ flexShrink: 0 }}>{session.status}</span>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                            {session.completed_passes}/{session.target_passes} passes
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </Reveal>
          </div>
        )}

        {/* Right column */}
        <div className="brainstorm-col-right">
          {currentSession ? (
            <>
              <Reveal delay={0.02}>
                <div className="v5-card glass flat-hover">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
                    <h2 style={{ fontFamily: 'var(--display)', fontSize: 17, fontWeight: 600, color: 'var(--text-bright)', margin: 0 }}>{currentSession.name}</h2>
                    <span className={statusPillClass(currentSession.status)}>{currentSession.status}</span>
                  </div>
                  <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>{currentSession.description}</p>

                  {['intake', 'configuring', 'ready'].includes(currentSession.status) ? (
                    <PassConfigPanel session={currentSession} onStart={handleStart} />
                  ) : (
                    <PassTimeline session={currentSession} events={events} />
                  )}
                </div>
              </Reveal>

              {(currentSession.completed_passes ?? 0) > 0 && (
                <Reveal delay={0.06}>
                  <PlanDetail sessionId={currentSession.id} />
                </Reveal>
              )}

              {['running', 'paused'].includes(currentSession.status) && (
                <Reveal delay={0.1}>
                  <div className="v5-card glass flat-hover">
                    <div className="v5-card-label">Inject Feedback</div>
                    <UserMessageInput sessionId={currentSession.id} />
                  </div>
                </Reveal>
              )}

              {currentSession.status === 'done' && (
                <Reveal delay={0.1}>
                  <div className="v5-card glass flat-hover">
                    <div className="v5-card-label">Create Builder Workflow</div>
                    <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>Convert this brainstorm into a Builder workflow to start implementation.</p>
                    <button className="v5-btn primary" onClick={handleCreateWorkflow}>
                      Create Workflow
                    </button>
                  </div>
                </Reveal>
              )}
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 15, color: 'var(--text-dim)', marginBottom: 6 }}>No session selected</p>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Create a new brainstorm or select an existing session</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
