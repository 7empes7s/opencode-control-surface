# Brainstormer — SSE Wiring & UI Polish

## Goal
Wire real-time Server-Sent Events into BrainstormPage.tsx so pass progress is live, and fix the alert() workflow creation UX.

## What already exists (do not recreate)
- `/opt/opencode-control-surface/app/routes/BrainstormPage.tsx` — the main page (191 lines)
- `/opt/opencode-control-surface/app/components/brainstorm/PassTimeline.tsx` — pass progress display
- `/opt/opencode-control-surface/server/api/brainstorm-stream.ts` — SSE backend (exports `brainstormStreamHandler`)
- Backend SSE endpoint: `GET /api/brainstorm/stream?sessionId=<id>` — already wired in router.ts

## Changes needed

### 1. BrainstormPage.tsx — Wire SSE

Add a `useEffect` that opens an `EventSource` whenever `currentSession?.status === 'running'`.

The SSE URL is `/api/brainstorm/stream?sessionId=${currentSession.id}`.

The auth header cannot be set on EventSource. The backend brainstorm-stream handler does NOT require auth (check router.ts — the stream path checks the token via URL param or is public). If auth IS needed, pass it as `?sessionId=...&token=Brighton13` — check how `/api/builder/runs/${runId}/pass-live` is called in BuilderPage.tsx to match the pattern.

For each SSE message:
- Parse `JSON.parse(event.data)` into a `BrainstormEvent`
- Append it to the `events` state array
- If `type === 'pass_update'`, also call `pollSession(currentSession.id)` to refresh the `completed_passes` count
- If `type === 'done' || type === 'error' || type === 'consolidation_done'`, close the EventSource and call `pollSession` one final time + `fetchSessions()` to update the sidebar list

Close the EventSource on cleanup (return from useEffect).

Also: the `pollSession` callback is already defined but never called — it is only needed as a fallback now that SSE is wired, so you can remove the polling approach entirely and rely solely on SSE + the single final poll on completion.

### 2. BrainstormPage.tsx — Fix workflow creation UX

Currently `handleCreateWorkflow` uses `alert(...)`. Replace with:
- Import `useLocation` from `wouter`  
- After a successful workflow creation response, call `navigate('/builder')` to take the user to the Builder page so they can see the new workflow

### 3. BrainstormPage.tsx — Add headers to API calls

The `fetchSessions`, `handleStart`, `handleCreateWorkflow`, and the `pollSession` fetch calls are missing the auth header. Add `headers: { 'x-operator-token': 'Brighton13' }` to each fetch call.  

Wait — check first: read `/opt/opencode-control-surface/app/components/AuthPrompt.tsx` or similar to understand how the token is stored in the browser (likely `localStorage`). Match whatever pattern the other pages use.

### 4. Validate

Run: `cd /opt/opencode-control-surface && bun tsc --noEmit 2>&1 | grep -v node_modules`

It must produce zero output. Then rebuild: `bun run build 2>&1 | tail -5` and restart: `systemctl restart control-surface.service && sleep 3 && systemctl is-active control-surface.service`

## Success criteria
- No TypeScript errors
- BrainstormPage mounts, fetches sessions, shows pass timeline
- When a session is running, EventSource is open and passes update live
- On completion, user sees "done" status and Create Workflow button
- Workflow creation navigates to /builder


<!-- Builder run br_8ed34: failed at 2026-05-20T19:02:51.535Z — details: /opt/ai-vault/builder/2026-05-20-bw_28757-br_8ed34.md -->