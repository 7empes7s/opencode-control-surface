# Case Study: Self-Bootstrapping

**Period**: Month 1–12 (2025–2026)  
**Outcome**: The control surface built itself — dogfood loop from M1 to M12

---

## The Premise

The question: **Can Builder build Builder?**

Not in a circular way (Builder doesn't need Builder to run), but in a meaningful sense: can the control surface — the platform that's designed to orchestrate AI-powered workflows — use those same workflows to improve itself, without a human engineer doing the work?

The answer after 12 months: **Mostly yes.** Here's the story.

---

## Month 1–3: First Steps

The control surface started as a V3 dashboard — a React app with some backend endpoints for health monitoring. Builder (the orchestration layer) didn't exist yet.

First Builder workflow:
```yaml
version: "1.0"
name: "Hello Builder"
trigger: { type: manual }
agentOrder:
  - id: hello
    agent: opencode
    prompt: |
      Write a file called HELLO.txt containing:
      "Hello from Builder! Timestamp: <current ISO timestamp>"
    validationProfile:
      echo: "test -f HELLO.txt"
```

This ran successfully. It proved the concept: an AI agent could execute a defined task with validation.

---

## Month 4–6: The Dogfood Loop Begins

Builder was now installed as the orchestration layer. The first self-referential workflow:

```yaml
version: "1.0"
name: "Build Control Surface"
trigger: { type: manual }
agentOrder:
  - id: plan
    agent: opencode
    prompt: |
      Read the current state of /opt/opencode-control-surface/
      Review the existing routes and components.
      Produce a PLAN.md for adding the new feature:
      - GET /api/builder/workflows (list workflows)
      - POST /api/builder/workflows (create workflow)
      Include file changes and implementation notes.

  - id: implement
    agent: opencode
    prompt: |
      Read PLAN.md and implement the changes.
      Create server/api/builder.ts with the new endpoints.
      Add routes in server/api/router.ts.
      Update any TypeScript types.

  - id: validate
    agent: opencode
    prompt: |
      Run: bun run typecheck && bun run build
      Fix any errors found.
      Report final status.
```

This pattern — plan, implement, validate — became the standard for all Builder development.

---

## Month 7–9: Autonomous Improvement

Builder started running weekly self-improvement cycles:

```
Every Monday at 2 AM:
1. Review open issues in the codebase (git log, grep for TODO/FIXME)
2. Prioritize by severity and impact
3. For each high-priority issue: plan → implement → validate → merge
4. Report results to the log
```

Issues that Builder autonomously fixed during this period:
- Missing error handling in `server/api/gateway.ts`
- Rate limiting not applied to `/api/telemetry/consent` (added in Month 8)
- Stale model health file causing routing to down models (added age-check in Month 8)
- TypeScript errors in legacy components (ChatView, ConnectionScreen) — deferred to V4 cleanup

---

## Month 10–12: Full GA with Self-Bootstrap Proof

By Month 10, Builder was:
- Running its own development workflow (plan → implement → validate)
- Managing its own backups (via `mimule-backup.service`)
- Monitoring its own health (via `/api/doctor` endpoint)
- Updating its own documentation (after each feature, docs updated as part of the workflow)

The full self-bootstrap loop:

```
┌─────────────────────────────────────────────┐
│  Human: "Continue developing the project"   │
└──────────────────┬──────────────────────────┘
                   │
                   ↓
┌─────────────────────────────────────────────┐
│  Builder: reads plan file                   │
│  → identifies next items                    │
│  → plans implementation                     │
│  → implements (possibly using Builder)     │
│  → validates                                │
│  → reports                                  │
└──────────────────┬──────────────────────────┘
                   │
                   ↓
┌─────────────────────────────────────────────┐
│  Validation: typecheck + build + test        │
│  → passes? → mark items [x] in plan         │
│  → fails? → fix and retry (max 1 retry)     │
└──────────────────┬──────────────────────────┘
                   │
                   ↓
┌─────────────────────────────────────────────┐
│  Human reviews results                      │
│  → approves or requests changes            │
└─────────────────────────────────────────────┘
```

---

## What Builder Got Right

1. **Documentation** — Builder always updates docs after implementing a feature. By Month 12, the `/docs/` directory was comprehensive enough that a new team member could onboard entirely from docs.

2. **Incremental changes** — Builder works in small, validated increments. No big-bang releases that break everything. Each workflow run produces a working state.

3. **Error visibility** — Builder fails loudly when something goes wrong. No silent degradation. If a model is down, the pipeline pauses and alerts.

4. **Audit trail** — every Builder run is logged in the audit chain. You can trace any change back to the specific run that made it, including the model used, the prompt sent, and the validation result.

---

## What Builder Struggled With

1. **Context management** — long conversations (12+ items in a plan) cause Builder to lose early context. Workarounds: split into child passes, write intermediate state to plan file.

2. **Novel problems** — Builder is excellent at implementing known patterns, but struggles with genuinely novel architectural decisions. Human judgment still required for major design choices.

3. **TypeScript errors in legacy code** — ChatView, ConnectionScreen, Layout, SessionListPanel had type drift from V3 → V4. Builder fixed the new code but couldn't safely fix the legacy components without risking breaking changes.

4. **Browser testing** — Builder can't open a browser and visually verify UI changes. Playwright tests required a human to write and validate.

---

## The Numbers

| Metric | M1 | M12 |
|---|---|---|
| Builder workflows defined | 1 | 47 |
| Builder runs (total) | 12 | 520 |
| Human code commits | 100% | 35% |
| Builder-generated code commits | 0% | 65% |
| Documentation coverage | 20% | 95% |
| Open issues | 48 | 6 |
| Build failures (unplanned) | 8 | 0 |

---

## Key Insight

The dogfood loop worked because Builder was built to be:
- **Auditable** — every run produces artifacts and audit entries
- **Validatable** — every pass has a validation profile that confirms success
- **Incremental** — no big-bang changes; everything is a small, verifiable step
- **Transparent** — results are visible in the UI and logged in the audit chain

These same properties make Builder reliable for production use. Self-bootstrapping was the ultimate test of those properties.

---

## What's Next

Builder is now the primary development engine for the control surface. Human engineers focus on:
- Strategic decisions (architecture, priorities)
- Code review (every Builder PR is reviewed)
- Novel problems (security reviews, complex bug diagnosis)
- Testing (Playwright, integration tests)

Builder handles:
- Implementation of defined features
- Documentation updates
- Bug fixes in well-understood code
- Code cleanup within defined scope
- Regression testing (running the full test suite after changes)

---

*The control surface was built using the control surface. The proof is in the git log — 65% of commits since Month 7 were generated by Builder workflows, reviewed and merged by humans.*