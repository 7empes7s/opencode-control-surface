interface BrainstormEvent {
  type: string;
  seq?: number;
  role?: string;
  status?: string;
}

interface Session {
  completed_passes: number;
  target_passes: number;
}

interface PassTimelineProps {
  session: Session;
  events?: BrainstormEvent[];
}

const PASS_ROLES = ['Architect', 'UX Designer', 'Backend Engineer', 'Critic', 'Security Analyst', 'V1 Planner', 'V2 Planner', 'Summary Generator'];

const ROLE_DESCRIPTIONS: Record<string, string> = {
  'Architect': 'System design & constraints',
  'UX Designer': 'User flows & experience',
  'Backend Engineer': 'APIs & data modeling',
  'Critic': 'Challenges & edge cases',
  'Security Analyst': 'Threat model & risks',
  'V1 Planner': 'Stakeholder plan',
  'V2 Planner': 'Technical specification',
  'Summary Generator': 'Confidence & success criteria',
};

export default function PassTimeline({ session, events = [] }: PassTimelineProps) {
  const completed = session.completed_passes ?? 0;

  return (
    <div>
      {PASS_ROLES.slice(0, session.target_passes ?? 8).map((role, i) => {
        const seq = i + 1;
        const event = events.find(e => e.seq === seq);
        const status = event?.status ?? (seq <= completed ? 'completed' : seq === completed + 1 ? 'active' : 'pending');

        let dotStyle: React.CSSProperties = {
          width: 10,
          height: 10,
          borderRadius: '50%',
          flexShrink: 0,
        };
        if (status === 'completed') {
          dotStyle.background = 'var(--green)';
        } else if (status === 'active') {
          dotStyle.background = 'var(--amber-warn)';
          dotStyle.animation = 'pulse 1.5s infinite';
        } else {
          dotStyle.background = 'var(--border)';
        }

        const isActiveOrDone = status === 'completed' || status === 'active';

        return (
          <div
            key={role}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 0',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div style={dotStyle} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: isActiveOrDone ? 'var(--text-bright)' : 'var(--text-dim)', fontWeight: isActiveOrDone ? 500 : 400 }}>
                {seq}. {role}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>
                {ROLE_DESCRIPTIONS[role]}
              </div>
            </div>
            {status === 'completed' && <span className="pill green">Done</span>}
            {status === 'active' && <span className="pill amber">Running...</span>}
          </div>
        );
      })}
    </div>
  );
}
