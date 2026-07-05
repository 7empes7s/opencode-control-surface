# builder-demo-checkout

A tiny, real Bun + TypeScript checkout-total calculator, used as a staged demo
project for the MIMULE Control Surface's Builder showcase.

## What it does

- `src/discount.ts` — applies a percentage discount to a subtotal (cents).
- `src/tax.ts` — applies a percentage tax on top of an amount (cents).
- `src/checkout.ts` — `computeTotalCents()`: discount first, then tax on the
  discounted amount.

## Run it

```bash
bun test
```

## Why this exists

This repo is the small real app behind the Control Surface's Builder
showcase scenario (`e2e/demo/stage-builder-demo.sh` and
`e2e/demo/BUILDER_DEMO.md` in the `opencode-control-surface` repo). It is
deliberately tiny (3 source files, 1 test file, no framework, no external
dependencies) so a non-technical viewer can read the whole diff of "the bug"
and "the fix" in a few lines.
