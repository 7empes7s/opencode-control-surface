# Table UX Fix Plan — Filterable, Sortable, Paginated Tables + Section Collapse

**Date:** 2026-05-18
**Scope:** All data tables and SectionCard defaults across the control surface
**Design context:** `.impeccable.md` (read first)

---

## Phase 1 — Shared Infrastructure

- [x] Create `app/hooks/useTableControls.ts` — reusable hook: filter by query, sort by column (asc/desc), paginate (25 rows/page)
- [x] Create `app/components/TableControls.tsx` — renders search input + row count badge + pagination controls; accepts props from the hook

## Phase 2 — Wire Tables (all pages)

- [x] `app/routes/FinanceIntelPage.tsx` — wire `useTableControls` to runs table, enrichments table, portfolio configs table; add column-header sort on Date/Model/Status/Duration; add search filter; paginate at 25
- [x] `app/routes/ScoutPage.tsx` — wire to topics table; sort by Score/Vertical/Source; filter by headline; paginate
- [x] `app/routes/ModelsPage.tsx` — wire to model list table; sort by Name/Status/Latency; filter by model name; paginate
- [x] `app/routes/ProjectsPage.tsx` — wire to projects table; sort by Name/Created; filter; paginate (NOTE: uses card-based layout, not a table — no wired table needed)
- [x] `app/routes/GovernancePage.tsx` — wire to policies table, approvals table, audit log table; sort + filter + paginate each
- [x] `app/routes/JobsPage.tsx` — wire to jobs table; sort by Created/Status/Type; filter; paginate
- [x] `app/routes/IncidentsPage.tsx` — wire to incidents table; sort by Date/Severity/Status; filter; paginate
- [x] `app/routes/ReportsPage.tsx` — REMOVED: file does not exist; report UI is embedded in CompliancePage.tsx
- [x] `app/routes/ChannelsPage.tsx` — wire to channels/rules table; sort + filter + paginate
- [x] `app/routes/MarketplacePage.tsx` — wire to bundles table; sort + filter + paginate — NO TABLE: card layout only; market is organized as install card UI, not a data table. Skill runs shown in modal. Mark N/A.
- [x] `app/routes/CompliancePage.tsx` — wire to control mapping table; sort + filter + paginate
- [x] Any other page with a `<table>` or `.data-table` element — audit and wire (AuditPage, PaperclipPage, NewsBitesPage, LiteLLMPage wired; WorkflowsPage/TracePage tables are inline/contextual, no wiring needed)
- [x] Audit every `<SectionCard defaultOpen={true}>` across all page files — found 12 instances
- [x] For any SectionCard that contains a table or list with potentially many rows: change to `defaultOpen={false}` — updated BuilderPage queue/cards/skills tables, InfraPage stat cards (kept open), AutopipelinePage queue/approvals tables
- [x] Keep `defaultOpen={true}` only for: stat card grids at page top, short config forms (< 5 fields) — InfraPage stat cards kept, DoctorPage chart kept, MarketplacePage skills kept, RatingsPage comparison kept

## Phase 3 — SectionCard Collapse Defaults

- [x] Audit every `<SectionCard defaultOpen={true}>` across all page files — found 12 instances; kept open: InfraPage stat cards, DoctorPage error chart, MarketplacePage skills list, RatingsPage comparison; changed to false: BuilderPage project+git, BuilderPage queue table, BuilderPage skills table, AutopipelinePage queue table, AutopipelinePage approvals table
- [x] For any SectionCard that contains a table or list with potentially many rows: change to `defaultOpen={false}`
- [x] Keep `defaultOpen={true}` only for: stat card grids at page top, short config forms (< 5 fields)

## Phase 4 — Validation + Critique

- [x] Run `bun run typecheck && bun run build` — pass (build time 6.34s, 2671 modules, chunk size warning only)
- [x] Run `/critique` skill (`/opt/skills/critique/SKILL.md`) on Finance Intel + Scout pages — fix top 3 UX findings (FinanceIntelPage: removed marketing subtitle, replaced light stat icon colors with stat-row/stat-item, fixed `selected` attr → `defaultValue` on selects, replaced Tailwind responsive grid with inline style; ScoutPage: replaced light Tailwind colors with CSS vars, fixed getScoreColor→getScoreStyle using var(--color-*), fixed run list hover/selection styles, fixed pre block background)
- [x] Run `/critique` on Governance + Projects + Compliance — fix top 3 findings (source + deterministic critique: impeccable scan clean; Governance tables wrapped for horizontal safety and filtered-empty rows; Projects card list gained shared filter/pagination plus sort controls; Compliance moved dense content out of card headers into responsive bodies and tokenized result styles)
- [x] Run `/critique` on Jobs + Incidents + Reports — fix top 3 findings (JobsPage: selected→defaultValue on filter selects; IncidentsPage: page-header inline styles→CSS vars, segmented filter wrapped in btn-group; deterministic impeccable scan clean)
- [x] Final: `bun run typecheck && bun run build` passes clean


<!-- Builder run br_d612c: success at 2026-05-18T14:27:08.154Z — details: /opt/ai-vault/builder/2026-05-18-bw_cb524-br_d612c.md -->


<!-- Builder run br_a9b7d: success at 2026-05-18T14:53:14.100Z — details: /opt/ai-vault/builder/2026-05-18-bw_cb524-br_a9b7d.md -->


<!-- Builder run br_5301b: success at 2026-05-18T21:33:16.174Z — details: /opt/ai-vault/builder/2026-05-18-bw_cb524-br_5301b.md -->