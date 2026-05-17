# Multi-Agent Pipeline Example

A 3-pass workflow demonstrating parallel agents, fallback models, and artifact passing: plan → build → review.

## Files

```
multi-agent-pipeline/
├── README.md          # This file
└── pipeline.yaml      # The workflow definition
```

## The Workflow

```yaml
version: "1.0"
name: "Plan → Build → Review"
description: |
  Three-pass development workflow with model fallback.
  Pass 1 (plan): analyze and create a development plan
  Pass 2 (build): implement changes from the plan
  Pass 3 (review): security and quality review of the implementation
trigger:
  type: manual
agentOrder:
  - id: plan
    name: "Create Development Plan"
    agent: opencode
    model: editorial-heavy
    prompt: |
      Analyze the current project at /opt/opencode-control-surface/
      Read: package.json, server/index.ts, app/routes/
      Identify the next highest-priority improvement or bug fix.
      
      Output a PLAN.md file with:
      ## Task
      <one sentence describing what to build/fix>
      
      ## Changes Required
      <numbered list of file changes needed>
      
      ## Implementation Notes
      <any important context for the builder pass>
      
      Write PLAN.md to the artifact directory.
    validationProfile:
      echo: "test -f PLAN.md && wc -l PLAN.md | awk '$1 > 10'"
      timeoutMs: 60000
    modelPolicy:
      allowed: ["gemma4:26b", "editorial-heavy"]
      fallbackChain: ["gemma4:26b", "editorial-cloud-heavy"]

  - id: build
    name: "Implement Changes"
    agent: opencode
    model: coding-heavy
    prompt: |
      Read PLAN.md from the artifact directory.
      Implement ALL changes described in PLAN.md.
      Focus on: correctness, type safety, no introduced warnings.
      
      After making changes:
      1. Run: bun run typecheck
      2. Fix any type errors found
      3. Run: bun run build
      4. Report: what files changed, build status (pass/fail)
      
      Write BUILD_STATUS.md with the results.
    validationProfile:
      echo: "bun run typecheck 2>&1 | tail -3"
      timeoutMs: 120000
    modelPolicy:
      allowed: ["gemma4:26b", "qwen2.5-coder:14b", "coding-heavy"]
      fallbackChain: ["gemma4:26b", "editorial-cloud-heavy"]

  - id: review
    name: "Security & Quality Review"
    agent: claude
    prompt: |
      Review the implementation in /opt/opencode-control-surface/
      Focus on:
      1. Security: SQL injection, XSS, exposed secrets, improper auth checks
      2. Correctness: logic bugs, race conditions, missing error handling
      3. Performance: N+1 queries, missing indexes, unbounded loops
      
      Read the changed files from the build pass.
      Run: bun run typecheck && bun run build (to confirm build still passes)
      
      Output a REVIEW.md file:
      # Code Review
      
      ## Files Reviewed
      <list of files changed>
      
      ## Security Findings
      <any security issues, or "None identified">
      
      ## Correctness Findings
      <any logic bugs, or "None identified">
      
      ## Performance Findings
      <any performance issues, or "None identified">
      
      ## Overall Verdict
      PASS | NEEDS_WORK | REJECT
      
      If needs_work or reject, explain what must be fixed.
      
      Write REVIEW.md to the artifact directory.
    validationProfile:
      echo: "test -f REVIEW.md && grep -q 'VERDICT' REVIEW.md"
      timeoutMs: 90000
    riskPolicy:
      requireApprovalFor: ["deploy-*"]
      auto remediate: false

  - id: merge
    name: "Merge Changes"
    agent: opencode
    prompt: |
      Read REVIEW.md.
      If verdict is PASS:
      - Create a git commit with the changes
      - Use commit message: "feat: $(head -1 PLAN.md | sed 's/## Task //')"
      - Tag the commit with the run ID
      
      If verdict is NEEDS_WORK:
      - Return error: "Review failed, fix issues before merging"
      
      If verdict is REJECT:
      - Return error: "Review rejected changes, see REVIEW.md"
      
      Write MERGE_STATUS.md with the outcome.
    validationProfile:
      echo: "test -f MERGE_STATUS.md"
      timeoutMs: 30000
    gitPolicy:
      allowPush: false  # Never push from this workflow (review first)
      commitMessageTemplate: "feat: {task}"

notification:
  channels: ["email", "webhook"]
  email: "platform@tib.com"
  webhookUrl: "https://internal.tib.com/alerts/review"
```

## Run It

```bash
builder run pipeline.yaml --tail
```

## What It Demonstrates

1. **3-pass sequential pipeline** — plan → build → review, each depending on the previous
2. **Model fallback chains** — if primary model fails, falls back to cloud alternatives
3. **Model policies per pass** — each pass can specify allowed models and fallback order
4. **Risk policy** — blocks deployments until review passes; no auto-remediation (safety first)
5. **Git policy** — commits changes but never force-pushes
6. **Conditional merge** — only merges if review verdict is PASS
7. **Notification on completion** — email + webhook regardless of outcome

## Model Selection Logic

| Pass | Primary Model | Fallback Chain | Rationale |
|---|---|---|---|
| plan | `gemma4:26b` | local → cloud | Heavy reasoning, needs best model |
| build | `coding-heavy` | local → cloud | Code generation, must not fail |
| review | `claude` | — | Security-focused, best for review |
| merge | `opencode` | — | Simple git operations, no model needed |

## Extension Ideas

- Add a `deploy` pass after `merge` that only runs if verdict is PASS and a specific tag is set
- Add a `test` pass between `build` and `review` that runs the full test suite
- Add `continueOnError: true` to the build pass so that if typecheck fails, the review pass still runs and evaluates the partial work