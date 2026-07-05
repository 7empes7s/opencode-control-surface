# Showcase Builder Demo — Checkout Total Calculator

Last updated: 2026-07-05

## About this project

A tiny, real Bun + TypeScript library (`src/discount.ts`, `src/tax.ts`,
`src/checkout.ts`) with `bun test` coverage (`tests/checkout.test.ts`). It
computes a checkout total: apply a percentage discount to the subtotal, then
apply tax on top of the discounted amount.

This project is staged for the Control Surface Builder showcase (ULTRAPLAN
P1.1 / SHOWCASE Phase 3) via `e2e/demo/stage-builder-demo.sh` in the
`opencode-control-surface` repo, and registered on the live Builder page as
project **"Showcase Builder Demo (staged)"**. See that repo's
`e2e/demo/BUILDER_DEMO.md` for the presenter script and the honest
staged-data-vs-live-mechanism breakdown.

## Phase 1 — Diagnose the current test status (this pass only)

- [ ] Run `bun test` in this repo's root and read the output. Do NOT edit any
      file under `src/` (or anywhere else) during this pass — this pass is
      diagnostic-only. The Builder pipeline runs `bun test` again itself,
      independently, right after your pass, via its own validation step — so
      it does not need you to have fixed anything for that check to be real.
      Write a short summary of exactly which test(s) passed or failed, and
      the specific assertion/values involved, into this pass's PASS_RESULT.json
      `passNote`. Mark this item `[x]` once you've reported that result —
      your job for this pass is done regardless of whether the tests
      currently pass or fail. Report `status: "incomplete"` (there is a
      Phase 2 item still unchecked) with `nextInstruction` pointing at Phase 2
      if `bun test` failed, or `status: "complete"` if it already passed and
      Phase 2 is therefore not needed (then also mark Phase 2 `[x]` with a
      note that it was unnecessary).

## Phase 2 — Fix the bug (only act on this after Phase 1 is checked off)

- [ ] If Phase 1 found `bun test` failing, find the specific root-cause line
      in `src/discount.ts` or `src/tax.ts` (not the test file — the tests in
      `tests/checkout.test.ts` describe the intended, correct behavior) and
      fix it so `bun test` passes. Do not change any test's expectations to
      make it pass — a genuine fix makes the existing assertions true.
