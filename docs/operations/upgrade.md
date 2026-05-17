# Upgrade Procedure

**Version**: 1.0.0

---

## Overview

Builder uses a rolling upgrade strategy with backward compatibility. Major versions (e.g., v1 → v2) require migration steps; minor versions (v1.0 → v1.1) are drop-in replacements.

---

## Pre-Upgrade Checklist

1. Read the [changelog](../changelog.md) for breaking changes
2. Verify backup is recent: `ls /opt/backups/latest/`
3. Check disk space: `df -h /`
4. Notify users of maintenance window (if applicable)
5. Note current version: `curl -s http://127.0.0.1:3000/api/version`

---

## Upgrade Steps

### Option A — Minor Version (v1.0 → v1.1)

Minor versions are backward-compatible. Upgrade in-place:

```bash
# 1. Pull latest binary
curl -L https://control.techinsiderbytes.com/install.sh | bash

# 2. Restart service
sudo systemctl restart control-surface.service

# 3. Verify
curl -s http://127.0.0.1:3000/api/version | python3 -c "import sys,json; v=json.load(sys.stdin); print(f'upgraded to {v[\"version\"]}')"
```

### Option B — Major Version (v1 → v2)

Major versions introduce breaking changes. Follow the migration path:

```bash
# 1. Read migration guide (docs/operations/upgrade.md or /api/version response headers)
# Migration guide URL in X-API-Migrate-To header

# 2. Export data from v1
curl -H "Authorization: Bearer $TOKEN" \
  https://control.techinsiderbytes.com/api/audit/export \
  -d '{"from": "2025-01-01", "to": "2026-05-17", "format": "json"}' > /tmp/v1-audit.json

# 3. Install new version
curl -L https://control.techinsiderbytes.com/install.sh | bash
# Or: download from https://control.techinsiderbytes.com/releases/v2.0.0/

# 4. Run config migration
builder config migrate --from /opt/backups/v1-config.tar.gz

# 5. Restart
sudo systemctl restart control-surface.service

# 6. Verify v2 API is responding
curl -s http://127.0.0.1:3000/api/version | python3 -c "import sys,json; print(json.load(sys.stdin)['apiVersion'])"
# → v2
```

---

## Config Migration

When upgrading, compare-and-merge strategy is used:

1. Old config: `~/.builder/config.toml` (pre-upgrade)
2. New default config: installed with new binary
3. Merged config: `~/.builder/config.toml` (post-upgrade)

New config keys added by the installer are set to defaults. Existing keys are preserved.

```bash
# Manual merge
builder config diff --old /tmp/old-config.toml --new /tmp/new-config.toml
# Shows new keys added, removed keys (may need manual attention)
```

---

## Rollback

If upgrade fails or causes issues, rollback to previous version:

```bash
# 1. Stop service
sudo systemctl stop control-surface.service

# 2. Restore previous binary (from backup or previous install location)
# Previous binary backed up at:
cp /usr/local/bin/builder /usr/local/bin/builder.v1.0.0.bak  # before upgrade

# 3. Restore previous config (if config migration caused issues)
cp /opt/backups/latest/config.tar.gz /tmp/ && tar -xzf /tmp/config.tar.gz -C /

# 4. Restart
sudo systemctl start control-surface.service

# 5. Verify
curl -s http://127.0.0.1:3000/api/version
```

---

## Health Checks After Upgrade

After any upgrade, run these checks:

```bash
# 1. Version endpoint returns expected version
curl -s http://127.0.0.1:3000/api/version | python3 -m json.tool

# 2. Health endpoint returns ok
curl -s http://127.0.0.1:3000/api/home | python3 -c "import sys,json; print('OK' if json.load(sys.stdin) else 'FAIL')"

# 3. Run a test workflow
cd /tmp && cat > test.yaml << 'EOF'
version: "1.0"
name: "upgrade-test"
trigger: { type: manual }
agentOrder:
  - id: test
    agent: opencode
    prompt: "echo 'upgrade test passed'"
    validationProfile:
      echo: "test -d /tmp"
EOF
builder run test.yaml && echo "workflow OK"

# 4. Check for errors in logs
journalctl -u control-surface.service --since "5 minutes ago" | grep -i error
```

---

## Upgrade with Zero Downtime

For production deployments requiring zero downtime:

1. Use two instances (active + standby)
2. Upgrade standby first
3. Run smoke tests on standby
4. Switch load balancer to standby
5. Upgrade former active (now standby)

This requires a load balancer and is optional for most deployments.

---

## Post-Upgrade Tasks

1. Update documentation if config keys changed
2. Notify users of any new features
3. Archive old audit logs (if retention policy changed)
4. Monitor error rate for 24 hours after upgrade

---

## Getting Help

If upgrade fails:
1. Check [troubleshooting guide](./troubleshooting.md)
2. Rollback (see above)
3. Contact support with: version info, error logs, backup date used