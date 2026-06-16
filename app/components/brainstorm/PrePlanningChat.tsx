import { useState, useRef, useEffect } from 'react';
import type { DiscoveredProject } from './ProjectPicker';
import { authFetch } from '../../lib/authFetch';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Brief {
  name: string;
  description: string;
  specs: string;
  project_mode: 'new' | 'existing';
  codebase_path?: string;
}

interface PrePlanningChatProps {
  onBriefGenerated: (brief: Brief) => void;
  onClose: () => void;
  projects: DiscoveredProject[];
}

export default function PrePlanningChat({ onBriefGenerated, onClose, projects }: PrePlanningChatProps) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: "Hi! Let's figure out what you want to build. Tell me your idea — even rough is fine — and I'll ask a few questions to sharpen it up." },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [selectedProject, setSelectedProject] = useState<DiscoveredProject | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const userMsg: Message = { role: 'user', content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setSending(true);
    try {
      const res = await authFetch('/api/brainstorm/preflight/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages,
          selectedProject: selectedProject ?? undefined,
        }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply ?? '' }]);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '(Error reaching AI — please try again)' }]);
    } finally {
      setSending(false);
    }
  };

  const finalize = async () => {
    setFinalizing(true);
    try {
      const res = await authFetch('/api/brainstorm/preflight/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          selectedProject: selectedProject ?? undefined,
        }),
      });
      const brief: Brief = await res.json();
      // If user had a project selected and mode is existing, ensure path is set
      if (selectedProject && brief.project_mode === 'existing' && !brief.codebase_path) {
        brief.codebase_path = selectedProject.path;
      }
      onBriefGenerated(brief);
    } catch {
      setFinalizing(false);
    }
  };

  return (
    // Overlay
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'oklch(0% 0 0 / 65%)',
        backdropFilter: 'blur(3px)',
        zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: '100%',
          maxWidth: 560,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>Plan with AI</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Describe your idea — I'll help you shape it</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-dim)', cursor: 'pointer', padding: '4px 8px', fontSize: 12 }}>✕</button>
        </div>

        {/* Project selector (optional) */}
        {projects.length > 0 && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
            <select
              className="form-input w-full"
              style={{ fontSize: 12 }}
              value={selectedProject?.path ?? ''}
              onChange={e => {
                const p = projects.find(p => p.path === e.target.value) ?? null;
                setSelectedProject(p);
              }}
            >
              <option value="">No project selected (new idea)</option>
              {projects.map(p => (
                <option key={p.path} value={p.path}>{p.name}{p.tech.length ? ` — ${p.tech.slice(0, 2).join(', ')}` : ''}</option>
              ))}
            </select>
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '80%',
                padding: '8px 12px',
                borderRadius: m.role === 'user' ? '8px 8px 2px 8px' : '8px 8px 8px 2px',
                background: m.role === 'user' ? 'var(--bg-hover)' : 'var(--bg-raised)',
                border: `1px solid ${m.role === 'user' ? 'var(--border-bright)' : 'var(--border)'}`,
                fontSize: 13,
                color: 'var(--text)',
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {m.content}
              </div>
            </div>
          ))}
          {sending && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{ padding: '8px 14px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: '8px 8px 8px 2px', color: 'var(--text-dim)', fontSize: 12 }}>
                Thinking…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Type your message… (Enter to send, Shift+Enter for newline)"
            className="form-input w-full"
            style={{ height: 68, resize: 'none', fontSize: 13 }}
            disabled={sending}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              style={{
                background: 'var(--bg-raised)', color: 'var(--text)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: sending ? 'not-allowed' : 'pointer',
                opacity: sending || !input.trim() ? 0.4 : 1, fontFamily: 'var(--sans)',
              }}
            >
              Send
            </button>
            <button
              onClick={finalize}
              disabled={finalizing || messages.length < 3}
              style={{
                background: messages.length >= 3 ? 'var(--accent)' : 'var(--bg-raised)',
                color: messages.length >= 3 ? 'var(--bg)' : 'var(--text-dim)',
                border: 'none', borderRadius: 6, padding: '6px 16px', fontSize: 12, fontWeight: 600,
                cursor: finalizing || messages.length < 3 ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--sans)',
                opacity: finalizing ? 0.5 : 1,
              }}
            >
              {finalizing ? 'Generating…' : 'Generate Brief →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
