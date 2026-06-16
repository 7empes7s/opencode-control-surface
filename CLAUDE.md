# Control Surface — session context (Fable 5, remote control)

**FIRST: read `CONTROL_SURFACE_BRIEFING.md` in this directory.** It has the full context, current state, operating rules, and objectives. Then read `/root/CLAUDE.md` for stack-wide rules.

## Critical rules (do not relearn the hard way)
- The autonomous build team (`mimule-jobd`) is **PAUSED on purpose** — its Playwright/Chromium-heavy validation + leaked ephemeral servers wedge the live demo site. **Do NOT resume `mimule-jobd`** or re-enable the orchestrator/project-improve/overseer timers. Hand-build instead.
- A rogue `opencode-control-surface.service` was the wedge engine — it's disabled; keep it dead.
- **Clean single-build pattern** (never wedged): edit → `bun run typecheck` → `bun run build` → ephemeral boot check (`PORT=34xx DASHBOARD_DB=1 bun run server/index.ts &`, curl, kill) → `systemctl restart control-surface.service` → verify site fast (`curl :3000`) + `/api/version`. **Never run Playwright on this box.**
- Never touch `/opt/newsbites` (live). Studio (`/opt/studio-platform`, :3300) stays held — leave it.
- **Verify the LIVE product before claiming anything done.** Log meaningful work to `/opt/ai-vault/daily/2026-06-11.md`.

## Status
The showcase spine (Phases 0–5) is **COMPLETE**, the Product Health Sentinel is **100/100**, the demo site is rock-solid. Real identity, the Insights Inbox (fed by the sentinel), the self-correction proof on `/agent-team`, plain-English UX, and `/api/metrics/showcase` are all live.

**Objectives = the Tier 2 / Tier 3 backlog in `CONTROL_SURFACE_BRIEFING.md`** (Insights apply-path, sentinel v2, CFO cost headline, Defender-lite security surface), plus the pending off-box-build decision (Marouane's call). Pick the highest-value item, hand-build it cleanly, verify live.
