# V5 "Observatory" — Redesign Contract (READ FULLY BEFORE EDITING)

You are reskinning pages of the TIB Control Surface in the git worktree
`/opt/control-surface-preview` (branch `redesign/v5`). The new design system
already exists. Your job: apply it to your assigned pages. Do NOT rebuild it.

## Hard rules

1. **Never** edit these shared files: `app/globals.css`, `app/v5.css`,
   `app/App.tsx`, `app/components/DashSidebar.tsx`, `app/components/DashHeader.tsx`,
   `app/components/v5/*`, anything under `server/`, `preview-server.ts`.
2. **Never** change data logic: hooks (`useApi`, `useStream`, `useAction`),
   fetch URLs, authFetch calls, SSE/WebSocket code, wouter route paths.
   You may ONLY change *rendering*: JSX structure, classNames, inline styles,
   icons (lucide-react), and add presentational wrappers.
3. **No new dependencies.** Available: framer-motion, lucide-react, recharts,
   three/@react-three/fiber (only if a page already imports it — do not add
   new 3D scenes).
4. **Do NOT run `bun run build` or `bun run typecheck`** — the orchestrator
   builds centrally (parallel agents share dist/). You may run
   `bunx tsc --noEmit -p tsconfig.json` ONLY if you limit output reading.
5. Keep every interactive control working: buttons, forms, modals, tabs,
   drawers. If a page has operator actions (deploy/restart buttons), keep
   them exactly as-wired; only restyle.
6. TypeScript must stay valid. Keep existing prop types/imports unless unused
   after your reskin (remove newly-unused imports).

## Design language

Dark deep-space indigo + electric cyan→violet gradient accent, glass panels,
Space Grotesk display font, spring-physics motion. Mobile-first.

### Tokens (CSS vars — use `var(--x)` in inline styles)
`--bg, --bg-panel, --bg-raised, --bg-sub, --glass, --border, --border-bright,
--border-glow, --text, --text-dim, --text-muted, --text-bright, --accent,
--accent-2, --accent-dim, --grad-accent, --grad-accent-soft, --green,
--amber-warn, --red, --blue, --mono, --sans, --display, --r-sm(8) --r-md(12)
--r-lg(18) --r-xl(26)`

### Building blocks already in `app/v5.css` — PREFER these over inventing CSS
- `.v5-pagehead`, `.v5-pagehead-title`, `.v5-pagehead-sub`, `.v5-pagehead-row`
  → top-of-page header. Use on EVERY page (replace old `.dash-section-title` headers).
- `.v5-card` (+`.glass`, +`.flat-hover` to disable lift) — panels.
- `.v5-card-label` — small uppercase caption inside cards.
- `.v5-stat`, `.v5-stat-value` (+`.gradient`), `.v5-stat-cap` — KPI tiles.
- `.v5-grid .stats/.cards/.split` — responsive grids. `.v5-section`, `.v5-section-head`, `.v5-section-title`, `.v5-section-link`.
- `.v5-pill` (+`.ok/.warn/.err/.info`), `.v5-dot` (+`.ok/.warn/.err/.idle`) — status.
- `.v5-btn` (+`.primary`, +`.ghost`) — buttons (min-height 40px = touch friendly).
- `.v5-table-wrap` + `.v5-table` (+`.responsive` with `data-label` on each `<td>`
  so rows become cards on ≤720px) — ALWAYS use for tables.
- `.v5-skeleton` — loading states (replace ugly spinners/text).
- `.v5-msg` (+`.user`) — chat message bubbles.
- `.v5-live.on/.off` — live stream indicator.
- Keyframes in use automatically: `.v5-page` fade-up on every route (already global).

### TSX primitives — `app/components/v5/ui.tsx`
`AnimatedNumber {value,decimals,suffix,prefix}` — spring count-up.
`Reveal {delay}` — fade-up on mount. `RevealOnView` — on scroll into view.
`Dot {tone}` — pulsing status dot. `Stat {label,value,caption,gradient,tone}`.
`Sparkline {points,width,height,stroke}` — SVG sparkline.
`PostureRing {pct,tone,label,sub}` — radial gauge.
`SectionHead {title,icon,link,linkLabel}`.
Import: `import { Stat, Reveal } from "../components/v5/ui";`
(adjust relative depth — routes use `../components/v5/ui`).

### Charts
recharts is available. Style tooltips dark:
`contentStyle={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }}`.
Use `var(--accent)` / `var(--accent-2)` strokes, gradient fills.

## Recipe per page

1. Read the page file fully first. Understand its sections.
2. Add the v5 pagehead at the top (title from navRegistry label, sub from
   existing description or `getRouteMeta`).
3. Wrap KPI numbers in `<Stat>` / `AnimatedNumber`; wrap lists in `.v5-card`.
4. Convert tables: wrap in `.v5-table-wrap`, class `.v5-table responsive`,
   add `data-label="<Column>"` to every `<td>`.
5. Replace raw `<button>` with `.v5-btn` (keep onClick!). Replace `.pill`
   spans with `.v5-pill` variants where trivially mappable.
6. Loading states → `.v5-skeleton` blocks. Empty states → one calm sentence,
   `color: var(--text-muted)`.
7. Wrap major sections in `<Reveal delay={0.04*n}>` for stagger (n = section index).
8. Mobile check: anything with fixed pixel widths > 340 must become fluid
   (maxWidth 100%, grid auto-fit). Font sizes ≥ 11px for readable text.
9. Keep inline-style approach for one-off styles; do NOT create new CSS files.

## Definition of done (per file)

- Page renders with pagehead + v5 cards; no legacy `.dash-section-title`,
  `.w-card`, `.widget-grid`, `.gov-*` classes remain in YOUR files.
- All handlers intact; no new TS errors introduced by your edit.
- You did NOT touch shared files or run builds.

Report back: files changed, anything you could NOT reskin and why.
