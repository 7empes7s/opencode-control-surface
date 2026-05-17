# Custom Validators

**Estimated time**: 15 minutes  
**Goal**: Write a custom validation command that checks your specific requirements — in this example, ensuring a Kubernetes deployment has a healthy replica count and no pod errors.

---

## What is a custom validator?

Beyond the built-in `exit_code` validator, you can write any shell command as a validation. The validation passes if the command exits `0` and fails otherwise. This lets you check:
- Structured output (JSON, YAML)
- Log patterns
- Metrics thresholds
- External health endpoints

---

## Step 1 — Create a validation script

In your project, create `validators/check-k8s-health.sh`:

```bash
#!/usr/bin/env bash
set -e

NAMESPACE="${NAMESPACE:-production}"
MIN_REPLICAS="${MIN_REPLICAS:-2}"

# Get deployment replica count
REPLICAS=$(kubectl get deployment -n "$NAMESPACE" -o jsonpath='{.items[0].status.readyReplicas}' 2>/dev/null || echo "0")

if [ "$REPLICAS" -lt "$MIN_REPLICAS" ]; then
  echo "FAIL: expected at least $MIN_REPLICAS ready replicas, got $REPLICAS"
  exit 1
fi

# Check for pod errors in the namespace
ERROR_PODS=$(kubectl get pods -n "$NAMESPACE" --field-selector=status.phase=Failed 2>/dev/null | wc -l)
if [ "$ERROR_PODS" -gt 0 ]; then
  echo "FAIL: $ERROR_PODS failed pods found in namespace $NAMESPACE"
  exit 1
fi

echo "OK: $REPLICAS ready replicas, 0 failed pods"
exit 0
```

Make it executable:
```bash
chmod +x validators/check-k8s-health.sh
```

---

## Step 2 — Use it in a workflow

```yaml
name: deploy-prod
description: "Deploy with K8s health check"

steps:
  - name: deploy
    command: kubectl apply -f k8s/production/
    validations:
      - kind: exit_code
        expect: 0

  - name: k8s-health
    command: ./validators/check-k8s-health.sh
    validations:
      - kind: exit_code
        expect: 0
```

---

## Step 3 — Test the validator in isolation

```bash
NAMESPACE=production MIN_REPLICAS=1 ./validators/check-k8s-health.sh
```

If your cluster is reachable and healthy, you'll see `OK: 2 ready replicas, 0 failed pods`.

---

## Step 4 — Run the full workflow

```bash
opencode builder run workflows/deploy-prod.yaml
```

The validator runs after the deploy step:
```
  step k8s-health ........... pass ✓ (1.2s)
```

If the cluster is unhealthy:
```
  step k8s-health ........... FAIL ✗ (1.1s)
  stderr: FAIL: expected at least 2 ready replicas, got 1
```

---

## Reusable validator library

You can share validators across workflows by placing them in a `validators/` directory at the project root. The builder automatically adds `validators/` to the `PATH` when running validation commands, so you can call `./validators/check-X.sh` without a relative path.

---

## What you learned

- Custom validators are just executables that exit `0` (pass) or non-zero (fail)
- They receive environment variables for configuration
- Validator output is captured in `run.json` under `validations[].stderr`
- Reusable validators live in `validators/` and are on the `PATH` during validation

---

## Next steps

- [05-publishing-a-skill](./05-publishing-a-skill.md) — package your validators and workflow patterns as a reusable skill bundle