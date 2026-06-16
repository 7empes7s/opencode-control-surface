# **BRAINSTORMER FRONTEND DESIGN (Pass 2)**

---

## **1. Complete Component Tree**

### `BrainstormTab`
```tsx
interface BrainstormTabProps {
  tenantId: string;
  token: string;
}

// Children:
// - SessionList (if no active session)
// - IntakeForm (if no session exists)
// - SessionView (if session exists, regardless of status)
```

---

### `IntakeForm`
```tsx
interface IntakeFormProps {
  onSubmit: (data: {
    name: string;
    description: string;
    specs: string | null;
  }) => void;
  disabled?: boolean;
}

// Children:
// - form-group ×3
//   - form-label + form-input (name, description, specs)
// - SmartRecommendationOverlay (conditionally rendered)
// - btn-primary (Start Planning)
```

---

### `PassConfigPanel`
```tsx
interface PassConfigPanelProps {
  recommendedPasses: number | null;
  targetPasses: number;
  onTargetChange: (n: number) => void;
  complexityScore: number;
  complexityLevel: 'simple' | 'medium' | 'complex';
  disabled?: boolean;
}

// Children:
// - form-group (slider + display)
// - SmartRecommendationOverlay (on hover/focus of recommendation)
```

---

### `SmartRecommendationOverlay`
```tsx
interface SmartRecommendationOverlayProps {
  show: boolean;
  children: React.ReactNode; // Anchor element (e.g. recommended count badge)
  message: string;
  position: 'top' | 'bottom' | 'left' | 'right';
}

// No children — renders tooltip overlay
```

---

### `SessionView`
```tsx
interface SessionViewProps {
  session: BrainstormSession;
  tenantId: string;
  token: string;
  onMessageSubmit: (content: string) => void;
  onCreateWorkflow: () => void;
}

// Children:
// - PlanningHealthIndicator
// - PassTimeline
// - UserMessageInput
// - PlanPreview
// - SummaryView (if completed)
// - BuilderRunCreationPanel (if done)
```

---

### `PassTimeline`
```tsx
interface PassTimelineProps {
  passes: BrainstormPass[];
  activePassId: string | null;
}

// Children:
// - PassCard ×N
```

---

### `PassCard`
```tsx
interface PassCardProps {
  pass: BrainstormPass;
  isActive: boolean;
  isLastCompleted: boolean;
}

// Children:
// - ModelLabel
// - ConfidenceBar (if confidence_score exists)
// - action-feedback (for error state)
```

---

### `ConfidenceBar`
```tsx
interface ConfidenceBarProps {
  score: number | null; // 0.0 to 1.0
  size?: 'small' | 'medium'; // small for inline, medium for standalone
}

// No children
```

---

### `PlanningHealthIndicator`
```tsx
interface PlanningHealthIndicatorProps {
  session: BrainstormSession;
  lastPassError?: string | null;
}

// Children:
// - pill (.green/.amber/.gray) with status label
// - optional action-feedback if failed
```

---

### `UserMessageInput`
```tsx
interface UserMessageInputProps {
  onSubmit: (content: string) => void;
  disabled?: boolean;
}

// Children:
// - form-input (textarea)
// - btn (Send)
```

---

### `MessageBadge`
```tsx
interface MessageBadgeProps {
  content: string;
  timestamp: number;
  from: 'user' | 'system';
}

// No children
```

---

### `PlanPreview`
```tsx
interface PlanPreviewProps {
  planV1Content: string | null; // Final V1 plan
  liveDraftContent: string | null; // Most recent pass output
  liveDraftRole: BrainstormPassRole | null;
  liveDraftSequence: number | null;
  status: BrainstormSessionStatus;
}

// Children:
// - MarkdownRenderer (custom or simple <pre><code>)
```

---

### `SummaryView`
```tsx
interface SummaryViewProps {
  summaryContent: string | null;
  onDownload: () => void;
}

// Children:
// - MarkdownRenderer
// - btn (Download Summary)
```

---

### `BuilderRunCreationPanel`
```tsx
interface BuilderRunCreationPanelProps {
  onCreate: () => void;
  disabled: boolean;
}

// Children:
// - btn-primary (Create Builder Run)
```

---

### `ModelLabel`
```tsx
interface ModelLabelProps {
  model: string; // Full model ID
}

// No children
```

---

### `SessionList`
```tsx
interface SessionListProps {
  sessions: BrainstormSession[];
  onSelect: (id: string) => void;
  onCreateNew: () => void;
  loading?: boolean;
  error?: string | null;
}

// Children:
// - List of session cards (pill + name + status)
// - btn (New Session)
```

---

## **2. BuilderPage.tsx Tab Integration**

### Import Statement to Add
```ts
import { BrainstormTab } from "@/components/brainstorm/BrainstormTab";
```

### Tab Button JSX
```tsx
{/* Inside existing tab bar, before the "Settings" tab */}
<button
  className={activeTab === 'brainstorm' ? 'active' : ''}
  onClick={() => setActiveTab('brainstorm')}
>
  Brainstorm
</button>

{/* Existing tabs like 'Builder', 'Agents', 'Settings' remain */}
```

### Tab Content Rendering Block
```tsx
{activeTab === 'brainstorm' && (
  <div className="tab-content">
    <BrainstormTab tenantId={user.tenantId} token={authToken} />
  </div>
)}
```

---

## **3. State Management**

### `BrainstormTab` State & Effects

```tsx
const [sessions, setSessions] = useState<BrainstormSession[]>([]);
const [activeSession, setActiveSession] = useState<BrainstormSession | null>(null);
const [loading, setLoading] = useState(true);
const [error, setError] = useState<string | null>(null);
const [sse, setSse] = useState<EventSource | null>(null);

// Initial fetch
useEffect(() => {
  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/brainstorm/sessions', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to fetch sessions');
      const data: BrainstormSession[] = await res.json();
      setSessions(data);
      const active = data.find(s => s.status === 'running') || data[0] || null;
      setActiveSession(active);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  };
  fetchSessions();
}, [token]);

// SSE Setup
useEffect(() => {
  if (!activeSession) return;

  let es: EventSource;
  let retries = 0;
  const maxRetries = 5;
  const baseDelay = 2000;

  const connect = () => {
    es = new EventSource(`/api/brainstorm/sessions/${activeSession.id}/stream?token=${token}`);

    es.onopen = () => {
      console.log('SSE connected');
      retries = 0;
      setSse(es);
    };

    es.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'pass_started':
          setSessions(prev => prev.map(s => s.id === data.sessionId ? {
            ...s,
            status: 'running',
            updated_at: Date.now()
          } : s));
          setActiveSession(prev => prev?.id === data.sessionId ? {
            ...prev,
            status: 'running',
            updated_at: Date.now()
          } : prev);
          break;

        case 'pass_progress':
          // Optional: stream partial output
          break;

        case 'pass_completed':
          setSessions(prev => prev.map(s => s.id === data.sessionId ? {
            ...s,
            completed_passes: data.completedPasses,
            updated_at: Date.now()
          } : s));
          setActiveSession(prev => prev?.id === data.sessionId ? {
            ...data.session,
            updated_at: Date.now()
          } : prev);
          break;

        case 'pass_failed':
          setActiveSession(prev => prev?.id === data.sessionId ? {
            ...prev,
            status: 'failed',
            updated_at: Date.now(),
            error: data.error
          } : prev);
          break;

        case 'message_injected':
          setActiveSession(prev => prev?.id === data.sessionId ? {
            ...prev,
            updated_at: Date.now()
          } : prev);
          break;

        case 'session_done':
          setSessions(prev => prev.map(s => s.id === data.sessionId ? {
            ...data.session,
            status: 'done'
          } : s));
          setActiveSession(prev => prev?.id === data.sessionId ? data.session : prev);
          break;

        case 'session_failed':
          setActiveSession(prev => prev?.id === data.sessionId ? {
            ...prev,
            status: 'failed'
          } : prev);
          break;

        case 'state_catchup':
          setSessions(prev => prev.map(s => s.id === data.session.id ? data.session : s));
          if (activeSession.id === data.session.id) {
            setActiveSession(data.session);
          }
          break;

        default:
          console.log('Unknown event:', data.type);
      }
    };

    es.onerror = () => {
      es.close();
      if (retries < maxRetries) {
        const delay = baseDelay * Math.pow(2, retries);
        setTimeout(connect, delay);
        retries++;
      } else {
        console.error('SSE max retries exceeded');
      }
    };
  };

  connect();

  return () => {
    if (es) es.close();
  };
}, [activeSession?.id, token]);
```

---

## **4. Smart Recommendation Overlay**

### Complexity Score Calculation
```ts
function calculateComplexity(description: string, specs: string | null): number {
  const baseScore = description.length / 100;
  const keywords = [
    'api', 'auth', 'database', 'payment', 'social',
    'realtime', 'upload', 'email', 'multi-tenant', 'admin'
  ];
  const keywordCount = keywords.filter(kw => 
    (description + ' ' + (specs || '')).toLowerCase().includes(kw)
  ).length;
  return Math.floor(baseScore) + keywordCount;
}

function getComplexityLevel(score: number): ComplexityLevel {
  return score < 4 ? 'simple' : score < 8 ? 'medium' : 'complex';
}

function getRecommendedPasses(level: ComplexityLevel): number {
  return { simple: 6, medium: 9, complex: 12 }[level];
}
```

### Tooltip Copy
- **Simple (6 passes)**:  
  "This idea is straightforward. We'll use 6 planning passes to build a solid foundation quickly."

- **Medium (9 passes)**:  
  "Moderate complexity — we’ll go deeper with 9 passes to ensure all parts are well thought out."

- **Complex (12 passes)**:  
  "This involves multiple systems. We recommend 12 passes to fully explore architecture, security, and scalability."

### Overlay Positioning
```tsx
<SmartRecommendationOverlay
  show={showTooltip}
  position="top"
  message={tooltipMessage}
>
  <span
    style={{
      position: 'relative',
      display: 'inline-block',
      cursor: 'help'
    }}
    onMouseEnter={() => setShowTooltip(true)}
    onMouseLeave={() => setShowTooltip(false)}
    onFocus={() => setShowTooltip(true)}
    onBlur={() => setShowTooltip(false)}
  >
    {children}
    {showTooltip && (
      <div
        style={{
          position: 'absolute',
          top: '-50px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'var(--bg-panel)',
          color: 'var(--text)',
          padding: '8px 12px',
          borderRadius: '4px',
          border: '1px solid var(--border)',
          fontSize: '12px',
          whiteSpace: 'nowrap',
          zIndex: 1000,
          maxWidth: '250px',
          boxShadow: '0 2px 6px rgba(0,0,0,0.1)'
        }}
      >
        {message}
      </div>
    )}
  </span>
</SmartRecommendationOverlay>
```

---

## **5. Model Label Mapping**

| Model ID                            | Human Label             | Short Description                     | Speed     | Quality Tier |
|-------------------------------------|--------------------------|----------------------------------------|-----------|---------------|
| opencode/minimax-m2.5-free          | Fast Thinker              | Lightning-fast for simple logic        | Fast      | Medium         |
| opencode/nemotron-3-super-free      | Deep Analyst              | Strong reasoning for complex tasks     | Medium    | High           |
| opencode/deepseek-v4-flash-free     | Security Auditor          | Code & threat pattern specialist       | Fast      | High           |
| opencode/qwen3.6-plus-free          | Critical Reviewer         | Detail-oriented, great at feedback     | Medium    | High           |
| openrouter/google/gemma-4-31b-it:free| UX Visionary             | Creative interface designer            | Fast      | Medium         |
| editorial-cloud-heavy               | Editorial Pro (Premium)   | Premium deep analysis engine           | Slow      | Premium        |
| editorial-cloud-fast                | Editorial Express         | Fast draft writer, lower depth         | Fast      | Medium         |
| github-gpt41                        | GitHub Copilot Pro        | Paid-tier code generation              | Medium    | Premium        |

> Note: Only free models are currently enabled.

---

## **6. User Flows**

### A) New Session
1. User opens **Brainstorm** tab → sees `IntakeForm`
2. Fills: "Name", "What it does", optional "Specs"
3. As they type, complexity score updates → `SmartRecommendationOverlay` appears near slider
4. Slider auto-sets to recommended passes
5. Clicks **Start Planning** → POST `/api/brainstorm/sessions` → creates session
6. `SessionView` renders → SSE connects → planning begins
7. `PassTimeline` shows progress with `PassCard`s
8. At any point, user types in `UserMessageInput` → sends message → injected into next pass
9. On `session_done`, `PlanPreview` switches to `PLAN_V1.md`, `SummaryView` appears
10. Clicks **Create Builder Run** → POST `/api/brainstorm/sessions/:id/create-workflow` → workflow created with `status: 'draft'`

---

### B) Resume In-Progress Session
1. User returns → `BrainstormTab` fetches sessions → finds `status: 'running'`
2. Auto-selects active session → renders `SessionView`
3. SSE connects → immediately receives `state_catchup` event with full session state
4. `PassTimeline` renders up-to-date pass statuses
5. `PlanPreview` shows latest completed pass output
6. User can inject message or wait for completion

---

### C) Completed Session
1. `SessionView` shows:
   - `PLAN_V1.md` in `PlanPreview`
   - `SUMMARY.md` in `SummaryView`
   - Download button
   - `BuilderRunCreationPanel` with **Create Builder Run**
2. Clicking **Create Builder Run** triggers API call
3. Success → toast: "Draft workflow created in Builder"
4. User switches to Builder tab to continue

---

### D) Failed Pass
1. `PassCard` shows status = `failed`, displays error via `action-feedback`
2. Actions appear below:
   - **Retry Pass** → POST retry to server → SSE resumes
   - **Skip Pass** → server marks pass skipped, continues next
   - **Cancel Session** → sets `cancel_requested`, stops planning
3. `PlanningHealthIndicator` turns amber

---

## **7. PlanPreview During Planning**

```tsx
<PlanPreview
  planV1Content={session.plan_v1_path ? readFileSync(session.plan_v1_path, 'utf8') : null}
  liveDraftContent={lastCompletedPass?.output_raw || null}
  liveDraftRole={lastCompletedPass?.role || null}
  liveDraftSequence={lastCompletedPass?.sequence || null}
  status={session.status}
/>
```

- If `session.status !== 'done'` and `lastCompletedPass` exists:
  - Render: `Live draft from pass {n}: {role}`
  - Content: `lastCompletedPass.output_raw`
- Else if `session.status === 'done'` and `plan_v1_path` exists:
  - Load and show `PLAN_V1.md` content
- Uses `<pre className="markdown">{content}</pre>` or minimal markdown renderer

---

## **8. Empty & Error States**

| Component | Empty State | Loading State | Error State |
|---------|-------------|---------------|-------------|
| **SessionList** | "No brainstorm sessions yet. Start your first idea!" + "New Session" button | Skeleton list of 3 gray rows | "Failed to load sessions: {error}" + retry button |
| **IntakeForm** | Fully visible form | "Loading..." on submit button | Inline error below form: "Could not start session" |
| **PassTimeline** | "Planning not started. Click 'Start Planning'." | Animated pulse on timeline container | "Planning failed. {error}" + retry options |
| **PassCard** | N/A | Spinner inside card if `running` | `action-feedback` with error; "Retry" button |
| **PlanPreview** | "No output yet. Planning will begin shortly." | Shimmer gradient block | "Could not load plan: File missing" |
| **SummaryView** | Hidden until `session.done` | Hidden until `session.done` | "Summary not generated. {error}" |
| **UserMessageInput** | "Add a note to guide the planner…" (placeholder) | "Sending…" on button | "Failed to send: {error}" below input |
| **BuilderRunCreationPanel** | Hidden until `session.done` | "Creating…" on button | "Failed to create workflow: {error}" |
| **SessionView** | Shows children with their empty states | "Loading session…" | "Session not found or access denied." |

---

## **9. File List**

### ✅ New Files to Create

```
src/components/brainstorm/
├── BrainstormTab.tsx
├── IntakeForm.tsx
├── PassConfigPanel.tsx
├── SmartRecommendationOverlay.tsx
├── SessionView.tsx
├── PassTimeline.tsx
├── PassCard.tsx
├── ConfidenceBar.tsx
├── PlanningHealthIndicator.tsx
├── UserMessageInput.tsx
├── MessageBadge.tsx
├── PlanPreview.tsx
├── SummaryView.tsx
├── BuilderRunCreationPanel.tsx
├── ModelLabel.tsx
├── SessionList.tsx
└── types.ts (export all interfaces)
```

### 🛠️ Existing Files to Modify

```
src/pages/BuilderPage.tsx
  → Add import & tab button & content block

src/index.css (or global.css)
  → Add .markdown class for plan preview:
     .markdown {
       background: var(--bg-panel);
       padding: 16px;
       border-radius: 6px;
       border: 1px solid var(--border);
       font-family: var(--mono);
       white-space: pre-wrap;
       line-height: 1.5;
     }

server/api/brainstorm/sessions.ts
  → Add all required endpoints (POST, GET, DELETE, etc.)

server/db/dashboard.ts
  → Add schema migration for brainstorm_* tables (if not already present)
```

---

✅ **END OF BRAINSTORMER FRONTEND DESIGN (Pass 2)**  
Ready for: **Pass 3 — Component Implementation & API Integration**