# Publishing a Skill

**Estimated time**: 20 minutes  
**Goal**: Package your workflow patterns, validators, and templates into a reusable skill bundle that can be installed by other operators or shared publicly.

---

## What is a skill?

A skill is a self-contained bundle that provides:
- **Templates** — starter workflow YAML files
- **Validators** — reusable validation scripts
- **Documentation** — usage guides and examples
- **Metadata** — name, version, author, dependencies

Skills follow a standard directory structure so the builder can discover, install, and invoke them.

---

## Step 1 — Create the skill directory structure

```bash
mkdir -p my-skill/
mkdir -p my-skill/templates/
mkdir -p my-skill/validators/
mkdir -p my-skill/docs/
```

---

## Step 2 — Write the skill manifest

Create `my-skill/skill.yaml`:

```yaml
name: k8s-deploy
version: "1.0.0"
description: "Production Kubernetes deployment workflow with health validation"
author: "your-name"

dependencies:
  - kubectl >= 1.28
  - opencode >= 1.0.0

templates:
  - id: deploy-prod
    path: templates/deploy-prod.yaml
    description: "Production deploy with replica health check"
  - id: deploy-staging
    path: templates/deploy-staging.yaml
    description: "Staging deploy (no approval gate)"

validators:
  - id: k8s-health
    path: validators/check-k8s-health.sh
    description: "Checks replica count and failed pods"
```

---

## Step 3 — Write the templates

Create `my-skill/templates/deploy-prod.yaml`:

```yaml
name: deploy-prod
description: "Production deploy with K8s health gate"

steps:
  - name: deploy
    command: kubectl apply -f k8s/production/
    validations:
      - kind: exit_code
        expect: 0

  - name: health-check
    command: opencode skill run k8s-deploy --validator k8s-health
    validations:
      - kind: exit_code
        expect: 0

  - name: approve
    approval_required: true
    command: kubectl rollout status deployment/production
    validations:
      - kind: exit_code
        expect: 0
```

Create `my-skill/templates/deploy-staging.yaml` (simpler variant without approval gate):

```yaml
name: deploy-staging
description: "Staging deploy — no approval required"

steps:
  - name: deploy
    command: kubectl apply -f k8s/staging/
    validations:
      - kind: exit_code
        expect: 0
```

---

## Step 4 — Write the validator

Create `my-skill/validators/check-k8s-health.sh`:

```bash
#!/usr/bin/env bash
set -e
NAMESPACE="${NAMESPACE:-staging}"
REPLICAS=$(kubectl get deployment -n "$NAMESPACE" -o jsonpath='{.items[0].status.readyReplicas}' 2>/dev/null || echo "0")
[ "$REPLICAS" -ge 1 ] || { echo "FAIL: expected >= 1 replicas, got $REPLICAS"; exit 1; }
exit 0
```

---

## Step 5 — Document the skill

Create `my-skill/docs/usage.md`:

```markdown
# k8s-deploy skill

Deploys to Kubernetes with an optional health check gate.

## Usage

### Install
opencode skill install ./my-skill

### Run a template
opencode builder run --template k8s-deploy:deploy-prod

### Run a custom workflow using the validator
opencode builder run workflows/my-deploy.yaml

## Environment variables

| Variable | Default | Description |
|---|---|---|
| NAMESPACE | staging | Target Kubernetes namespace |
| MIN_REPLICAS | 1 | Minimum required ready replicas |
```

---

## Step 6 — Package and publish

Package the skill:
```bash
cd my-skill && tar -czvf k8s-deploy-1.0.0.tar.gz .
```

Publish to a registry (or serve locally):
```bash
opencode skill publish ./k8s-deploy-1.0.0.tar.gz --registry https://skills.opencode.ai
```

Or serve from a local directory for internal use:
```bash
opencode skill install ./my-skill --source local
```

---

## Step 7 — Install and verify

On another machine or for another operator:
```bash
opencode skill install k8s-deploy --version 1.0.0
opencode skill list
```

Verify the templates are available:
```bash
opencode builder template list | grep k8s-deploy
```

---

## What you learned

- **Skill manifest** (`skill.yaml`) declares metadata, templates, and validators
- **Templates** are ready-to-run workflow YAML files
- **Validators** are executables on the PATH during validation
- **Package as tarball** for distribution; install via registry or local path

---

## Next steps

Explore more advanced skill patterns:
- Add a `setup.sh` script for environment preparation
- Add a `teardown.sh` script for cleanup after runs
- Use `hooks/` to run code before/after steps