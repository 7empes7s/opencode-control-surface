# Case Study: NewsBites V4

**Period**: Month 1–12 (2025–2026)  
**Outcome**: Fully autonomous AI-operated news site serving 50K+ monthly readers

---

## Background

NewsBites is an AI-operated news site covering AI, finance, science, global politics, and culture. The goal in Month 1 was to build a system that could research, write, edit, and publish articles with minimal human intervention — while maintaining editorial quality and avoiding the pitfalls of fully automated media (factual errors, toneless prose, repetitive structure).

The editorial pipeline was built on the Builder platform.

---

## The 12-Month Plan

### Month 1–2: Foundation
- Deploy Next.js 16 + React 19 frontend
- Connect LiteLLM gateway to GPU (RTX 3090 via Vast.ai)
- Build first draft pipeline: research → write → verify

### Month 3–4: Editorial Quality
- Add multi-stage validation (factual check, readability score, digest length)
- Build the "small desk agent" system: each stage is a separate agent with a defined role
- First automatic publish to `news.techinsiderbytes.com`

### Month 5–7: Scale
- Add parallel cloud stages for when GPU is busy
- Implement dynamic model selection (fastest available model every 5 hours)
- Build the autopipeline continuous loop (scout → research → write → verify → rank → publish-prep)
- Add `panel_hints` for sports, finance, world, climate panels

### Month 8–9: Autonomy
- Full day-long runs with no human in the loop (except first-run for new verticals)
- Scout agent generates brief every 4 hours
- Auto-publish verticals: ai, trends, science, finance, global-politics, healthcare, culture, energy, climate, cybersecurity, economy, crypto

### Month 10–12: polish & GA
- Fix legacy component type errors
- Implement reader modes (Focus card-based, Flow TikTok-style)
- Add panel registry (sports, finance, world, climate embedded in articles)
- Build V4 control surface dashboard for monitoring

---

## Key Builder Runs

### Daily Scout Brief
Every 4 hours, the scout agent runs:
```
agent: opencode (routing-cheap model)
prompt: Scout top 10 stories across configured verticals.
        Output: JSON array of {topic, vertical, urgency, hook}
validationProfile: echo "test -f scout-brief.json"
```

### Research → Write Pipeline
```
Pass 1: research (editorial-cloud-heavy, parallel)
  → sources.json, DOSSIER.md

Pass 2: write (editorial-cloud-heavy, parallel)
  → draft.md

Pass 3: verify (local GPU, sequential, mutex lock)
  → verify.md (factual check, readability)

Pass 4: publish-prep (editorial-cloud-fast)
  → publish.md, final markdown
```

### Deploy
```
Pass 5: deploy (infra action)
  → newsbites-deploy script
  → systemctl restart newsbites.service
```

---

## Outcomes

| Metric | Month 1 | Month 12 |
|---|---|---|
| Articles published | 0 | ~120/month |
| Human edits per article | ~8 | ~1 (typos only) |
| Time from scout to publish | ~6 hours | ~45 min |
| Cost per article (GPU/cloud) | N/A | ~$0.12 |
| Factual error rate | ~15% | <2% |
| Reader sessions/month | 0 | 52,000 |

---

## What Worked

1. **Sequential GPU stages with mutex** — verify and scout run sequentially on GPU because they're high-stakes and the GPU is the most reliable model. Parallel cloud stages handle the heavy lifting (research, write).

2. **Dynamic model selection** — reading `/var/lib/mimule/model-health.json` every 5 hours means the pipeline always uses the fastest available model. When GPU is busy, cloud kicks in seamlessly.

3. **Dossier artifacts** — `DOSSIER.md`, `sources.json`, `draft.md`, `publish.md` mean every stage has context from previous stages. The plan file pattern works for continuation.

4. **Doctor review** — after any publish, a health check runs on the article. If it fails, a revision is triggered automatically.

---

## Challenges

### Challenge 1: Factual Errors in Early Months
**Problem**: Early gemma4:26b outputs had hallucination rate ~15%.  
**Solution**: Added a verification pass (Pass 3) that cross-references claims with source URLs. Error rate dropped to <2%.

### Challenge 2: GPU Saturation
**Problem**: When multiple pipelines ran simultaneously, GPU queued and latency spiked.  
**Solution**: GPU mutex lock (only one pipeline stage on GPU at a time); parallel cloud stages for research/write.

### Challenge 3: Stale Model Health
**Problem**: If model-health.json was >6h old, pipeline would route to a down model.  
**Solution**: Check file age at call time; fall back to defaults if stale.

### Challenge 4: Vertical First Runs
**Problem**: New verticals (e.g., "healthcare") needed human review before auto-publishing.  
**Solution**: `requireApprovalFor` in riskPolicy for first run of each new vertical; after first success, fully autonomous.

---

## Architecture Overview

```
Scout (cron, 4h) → Topic Queue
                     ↓
        ┌────────────┴────────────┐
        ↓                         ↓
  Research (cloud, parallel)  Research (cloud, parallel)
        ↓                         ↓
  Write (cloud, parallel)    Write (cloud, parallel)
        ↓                         ↓
  Verify (GPU, sequential)   Verify (GPU, sequential)
        ↓                         ↓
  Rank → Scout Brief         Rank → Scout Brief
        ↓                         ↓
  Publish-Prep (cloud-fast)
        ↓
  Deploy → news.techinsiderbytes.com
```

---

## Keys to Success

1. **Human-in-the-loop for new verticals** — first article in any new vertical is reviewed before publishing. Builds confidence in the pipeline before going fully autonomous.

2. **Cost discipline** — `routing-cheap` for triage/scouting; strong models only for synthesis/verification.

3. **Fail loud** — if a cloud model fails 3 times in a row, the pipeline pauses and alerts. No silent degradation.

4. **Dossier continuity** — every pass has full context from previous passes via artifacts. No lost state between stages.

---

*This case study was written 12 months into the NewsBites project, documenting the journey from zero articles to fully autonomous publication.*