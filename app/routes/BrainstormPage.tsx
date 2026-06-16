import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import IntakeForm from '../components/brainstorm/IntakeForm';
import PassConfigPanel from '../components/brainstorm/PassConfigPanel';
import PassTimeline from '../components/brainstorm/PassTimeline';
import PlanDetail from '../components/brainstorm/PlanDetail';
import UserMessageInput from '../components/brainstorm/UserMessageInput';
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


export default function BrainstormPage() {
  const [, navigate] = useLocation();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<BrainstormEvent[]>([]);
  const [loading, setLoading] = useState(true);

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

  if (loading) return (
    <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
      Loading...
    </div>
  );

  return (
    <div className="brainstorm-page">
      <div className="brainstorm-cols">
        {/* Left column */}
        <div className="brainstorm-col-left">
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
            <div className="dash-section-title" style={{ marginBottom: 12 }}>New Brainstorm</div>
            <IntakeForm onCreate={handleCreate} />
          </div>

          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
            <div className="dash-section-title" style={{ marginBottom: 12 }}>Recent Sessions</div>
            {sessions.length === 0 ? (
              <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>No sessions yet</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sessions.map(session => {
                  const isActive = currentSession?.id === session.id;
                  return (
                    <button
                      key={session.id}
                      onClick={() => { setCurrentSession(session); setEvents([]); }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: isActive ? '1px solid var(--accent)' : '1px solid var(--border)',
                        background: isActive ? 'var(--bg-raised)' : 'var(--bg-panel)',
                        cursor: 'pointer',
                        transition: 'background 0.15s, border-color 0.15s',
                      }}
                      onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-panel)'; }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-bright)' }}>{session.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                        {session.status} · {session.completed_passes}/{session.target_passes} passes
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="brainstorm-col-right">
          {currentSession ? (
            <>
              <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-bright)', margin: 0 }}>{currentSession.name}</h2>
                  <span className={`pill ${
                    currentSession.status === 'done' ? 'green' :
                    currentSession.status === 'running' ? 'blue' :
                    currentSession.status === 'failed' ? 'red' : 'gray'
                  }`}>{currentSession.status}</span>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>{currentSession.description}</p>

                {['intake', 'configuring', 'ready'].includes(currentSession.status) ? (
                  <PassConfigPanel session={currentSession} onStart={handleStart} />
                ) : (
                  <PassTimeline session={currentSession} events={events} />
                )}
              </div>

              {(currentSession.completed_passes ?? 0) > 0 && (
                <PlanDetail sessionId={currentSession.id} />
              )}

              {['running', 'paused'].includes(currentSession.status) && (
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
                  <div className="dash-section-title" style={{ marginBottom: 10 }}>Inject Feedback</div>
                  <UserMessageInput sessionId={currentSession.id} />
                </div>
              )}

              {currentSession.status === 'done' && (
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
                  <div className="dash-section-title" style={{ marginBottom: 8 }}>Create Builder Workflow</div>
                  <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>Convert this brainstorm into a Builder workflow to start implementation.</p>
                  <button
                    onClick={handleCreateWorkflow}
                    style={{
                      background: 'var(--accent)',
                      color: 'var(--bg)',
                      border: 'none',
                      borderRadius: 6,
                      padding: '7px 18px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'var(--sans)'
                    }}
                  >
                    Create Workflow
                  </button>
                </div>
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
