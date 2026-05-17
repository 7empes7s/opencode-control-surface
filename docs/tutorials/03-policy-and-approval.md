# Policy and Approval Gates

**Estimated time**: 15 minutes  
**Goal**: Configure a 4-eyes approval gate so that production-deployment steps require a second operator to explicitly approve before executing.

---

## Why approval gates?

Production deployments carry risk. A 4-eyes policy ensures that at least two operators (or one operator + one automated rule) must sign off before a sensitive step runs. This is useful for:
- Deploying to production
- Deleting data or dropping tables
- Modifying infrastructure configuration
- Running migrations on live databases

---

## Step 1 — Define a production workflow with a gate

Create `workflows/deploy-prod.yaml`:

```yaml
name: deploy-prod
description: "Deploy to production — requires approval"

steps:
  - name: build-artifacts
    command: opencode builder run build-workflow.yaml
    validations:
      - kind: exit_code
        expect: 0

  - name: pre-deploy-check
    command: opencode builder doctor --project .
    validations:
      - kind: exit_code
        expect: 0

  - name: deploy
    approval_required: true
    command: |
      echo "Deploying to production cluster..."
      kubectl apply -f k8s/production/
    validations:
      - kind: exit_code
        expect: 0
```

The `approval_required: true` field marks the step as requiring explicit approval.

---

## Step 2 — Enable approval enforcement in the operator config

Edit your `operator.yaml`:

```yaml
approval:
  enabled: true
  require_sso: true          # Operator must authenticate via SSO token
  require_second_operator: true  # A second distinct operator must approve
  approval_timeout: 7200     # Approval expires after 2 hours
```

---

## Step 3 — Run and observe the gate

```bash
opencode builder run workflows/deploy-prod.yaml
```

Instead of executing the `deploy` step, you'll see:
```
  step deploy ................ PENDINGApproval ⏳
    approval required: 4-eyes policy active
    waiting for second operator approval...
```

---

## Step 4 — Approve as second operator

From a separate session (or as a second operator):
```bash
opencode builder approve <run-id> --step deploy --operator <operator-name>
```

Or via the control surface UI:
1. Navigate to **Builder → Runs**
2. Find the pending run
3. Click **Approve** on the `deploy` step

Once approved, the step executes immediately.

---

## Step 5 — Reject or timeout

If something looks wrong, the approver can also:
```bash
opencode builder reject <run-id> --step deploy --reason "Wrong cluster targeted"
```

If no approval is given within the `approval_timeout` window, the step is marked as `expired` and the run halts.

---

## Monitoring pending approvals

```bash
opencode builder approval list --status pending
```

---

## What you learned

- **approval_required** field marks steps as sensitive
- **SSO requirement** ties approvals to real operator identities
- **Second operator rule** enforces the 4-eyes principle
- **Timeout** prevents approvals from being given indefinitely

---

## Next steps

- [04-custom-validator](./04-custom-validator.md) — write a custom validation command for your specific stack