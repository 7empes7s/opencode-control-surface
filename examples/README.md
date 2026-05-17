# Examples Index

Three workflow examples demonstrating Builder's core capabilities.

---

## hello-builder

**Level**: Beginner  
**Time**: 2 minutes  
**What**: Minimal single-pass workflow with echo validation

A "Hello World" for Builder. Write a text file, validate it exists. The simplest possible workflow that demonstrates all required fields.

**Run**: `builder run examples/hello-builder/hello.yaml --tail`

---

## scheduled-doctor

**Level**: Intermediate  
**Time**: 5 minutes (runs in ~2 min)  
**What**: Multi-pass nightly diagnostic workflow with cron trigger

A nightly health check that:
1. Discovers all running services
2. Checks GPU tunnel health
3. Checks model health status
4. Checks disk usage
5. Compiles a structured report
6. Sends a webhook alert only if critical issues found

Demonstrates: cron trigger, multi-pass sequential flow, conditional notification, skill bundle usage.

**Run**: `builder run examples/scheduled-doctor/doctor.yaml --tail`

---

## multi-agent-pipeline

**Level**: Advanced  
**Time**: 10–30 minutes (depends on implementation scope)  
**What**: Three-pass development workflow: plan → build → review

A full development pipeline:
1. **plan** — analyze project, create development plan
2. **build** — implement changes from plan, run typecheck + build
3. **review** — security and quality review (pass/fail verdict)
4. **merge** — conditional commit (only if review passes)

Demonstrates: model fallback chains, model policies per pass, risk policy, git policy, conditional merge, multi-notification.

**Run**: `builder run examples/multi-agent-pipeline/pipeline.yaml --tail`

---

## Which Example Should I Start With?

| Goal | Start with |
|---|---|
| Understand the basic workflow format | `hello-builder` |
| Schedule automated tasks | `scheduled-doctor` |
| Build a real development pipeline | `multi-agent-pipeline` |

---

## Extending the Examples

Each example includes suggested extensions in its README. Common extensions:
- Add more passes to `hello-builder` (validate content, then commit)
- Add email notification to `scheduled-doctor`
- Add a `deploy` pass to `multi-agent-pipeline` after `merge`
- Add model fallback overrides for cloud-heavy scenarios

---

## Files

```
examples/
├── README.md                  # This file
├── hello-builder/
│   ├── README.md
│   └── hello.yaml
├── scheduled-doctor/
│   ├── README.md
│   └── doctor.yaml
└── multi-agent-pipeline/
    ├── README.md
    └── pipeline.yaml
```