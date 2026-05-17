# Backup & Restore

**Version**: 1.0.0

---

## Overview

Builder maintains daily backups of:
- SQLite database (`builder.db`)
- Workflow definitions
- Artifact metadata (not full artifact content — see Retention below)
- Configuration files

Backups are created by `mimule-backup.service` daily at 04:00 UTC and stored in `/opt/backups/YYYY-MM-DD/`.

---

## Backup Directory Structure

```
/opt/backups/
├── 2026-05-17/
│   ├── builder.db.gz              # Compressed SQLite database
│   ├── workflows.tar.gz           # All workflow YAML files
│   ├── config.tar.gz              # /etc/builder/ and ~/.builder/
│   └── manifest.json              # Backup metadata (timestamp, sizes, checksum)
├── 2026-05-16/
│   └── ...
└── latest -> 2026-05-17/          # Symlink to most recent
```

---

## Backup Policy

| Data | Frequency | Retention | Storage |
|---|---|---|---|
| Database | Daily | 30 days | Local + optional S3 |
| Workflow definitions | Daily | 90 days | Local |
| Config | Daily | 90 days | Local |
| Artifacts | Each run (on workflow completion) | Per `backupPolicy` in workflow (default 30 days) | Local |

---

## Manual Backup

```bash
# Create a manual backup now
sudo systemctl start mimule-backup.service

# Verify backup was created
ls -la /opt/backups/$(date +%Y-%m-%d)/
```

---

## Restore Procedure

### Step 1 — Stop the service

```bash
sudo systemctl stop control-surface.service
```

### Step 2 — Identify the backup

```bash
# List available backups
ls /opt/backups/

# Choose a date (use 'latest' for the most recent)
BACKUP_DATE=2026-05-17
```

### Step 3 — Restore the database

```bash
# Decompress and restore
gunzip < /opt/backups/$BACKUP_DATE/builder.db.gz > /var/lib/builder/builder.db

# Verify integrity
sqlite3 /var/lib/builder/builder.db "PRAGMA integrity_check;"
```

### Step 4 — Restore workflows

```bash
tar -xzf /opt/backups/$BACKUP_DATE/workflows.tar.gz -C /
```

### Step 5 — Restore config

```bash
tar -xzf /opt/backups/$BACKUP_DATE/config.tar.gz -C /
```

### Step 6 — Restart

```bash
sudo systemctl start control-surface.service
sudo systemctl start builder-runner.service  # if used

# Verify
curl http://127.0.0.1:3000/api/health
```

---

## Cross-Version Migration

When restoring a backup from a different Builder version:

1. **Check version compatibility**:
   ```bash
   # Backup's version
   cat /opt/backups/$BACKUP_DATE/manifest.json | python3 -c "import sys,json; print(json.load(sys.stdin)['builderVersion'])"
   
   # Current version
   curl -s http://127.0.0.1:3000/api/version | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])"
   ```

2. **If restoring to a newer version**: Run DB migration
   ```bash
   builder db migrate /opt/backups/$BACKUP_DATE/builder.db
   ```

3. **If restoring to an older version**: Not supported — do not restore a newer backup onto an older installation. Use the older backup instead.

---

## Offsite Backup (Optional)

Configure S3 backup:
```toml
# ~/.builder/config.toml
[backup]
s3_bucket = "s3://my-builder-backups/"
s3_region = "eu-west-1"
```

When configured, backups are pushed to S3 after local storage.

---

## Restore from S3

```bash
# Install AWS CLI
pip install awscli

# List buckets
aws s3 ls s3://my-builder-backups/

# Download a specific backup
aws s3 cp s3://my-builder-backups/2026-05-17/builder.db.gz /tmp/builder.db.gz

# Follow Steps 3-6 above
```

---

## Disaster Recovery Timeline

| Time | Action |
|---|---|
| T+0 | Failure detected (alert or manual) |
| T+5min | SSH to server |
| T+10min | Stop service, assess damage |
| T+15min | Identify last good backup |
| T+20min | Follow restore procedure |
| T+30min | Service back online |
| T+45min | Verify all workflows intact |
| T+60min | Post-incident report |

---

## Verifying Backup Integrity

```bash
# Check manifest
cat /opt/backups/$BACKUP_DATE/manifest.json
# → { "timestamp": "...", "builderVersion": "1.0.0", "entries": [...] }

# Verify checksum of database
sha256sum /opt/backups/$BACKUP_DATE/builder.db.gz
# Compare with manifest entry for builder.db.gz
```