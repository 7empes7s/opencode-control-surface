import { useState } from 'react';
import { authFetch } from '../../lib/authFetch';

interface UserMessageInputProps {
  sessionId: string;
  onMessageSent?: () => void;
}

export default function UserMessageInput({ sessionId, onMessageSent }: UserMessageInputProps) {
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!msg.trim()) return;
    setSending(true);
    try {
      await authFetch(`/api/brainstorm/session/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg })
      });
      setMsg('');
      onMessageSent?.();
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <textarea
        value={msg}
        onChange={e => setMsg(e.target.value)}
        placeholder="Add feedback or new requirements..."
        className="form-input w-full"
        style={{ height: 96, resize: 'vertical' }}
      />
      <button
        onClick={send}
        disabled={sending || !msg.trim()}
        style={{
          background: (sending || !msg.trim()) ? 'var(--bg-raised)' : 'var(--accent)',
          color: 'var(--bg)',
          border: 'none',
          borderRadius: 6,
          padding: '7px 18px',
          fontSize: 13,
          fontWeight: 600,
          cursor: (sending || !msg.trim()) ? 'not-allowed' : 'pointer',
          opacity: (sending || !msg.trim()) ? 0.5 : 1,
          fontFamily: 'var(--sans)',
          alignSelf: 'flex-start'
        }}
      >
        {sending ? 'Sending...' : 'Inject Feedback'}
      </button>
    </div>
  );
}
