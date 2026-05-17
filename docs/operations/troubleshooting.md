# Troubleshooting

**Version**: 1.0.0

---

## Common Failure Modes

### Service Won't Start

**Symptoms**: `systemctl start control-surface.service` fails or times out.

**Diagnosis**:
```bash
# Check service status
systemctl status control-surface.service

# Check logs
journalctl -u control-surface.service -n 50

# Check if port 3000 is already bound
ss -ltn | grep :3000
```

**Common causes**:
1. **Port 3000 already in use** — another process is using the port. Find it: `ss -ltn | grep :3000`. Stop it or reconfigure builder to use a different port.
2. **Database locked** — another builder instance is running. Check: `ps aux | grep builder`.
3. **Permission denied** — running as wrong user. Builder should run as `root` or `builder` user.
4. **Missing config** — `~/.builder/env` not found. Create it with `BUILDER_HOST` and `BUILDER_TOKEN`.

**Fix**:
```bash
# Find conflicting process
ss -ltn | grep :3000
# → tcp 0 0 0.0.0.0:3000 0.0.0.0:*  LISTEN  1234/nginx

# Stop nginx (or reconfigure to proxy to builder)
sudo systemctl stop nginx
sudo systemctl start control-surface.service

# Or use a different port
echo "BUILDER_PORT=3001" >> ~/.builder/env
sudo systemctl restart control-surface.service
```

---

### GPU Tunnel Down

**Symptoms**: All AI requests fail with `model not responding` or `connection refused`.

**Diagnosis**:
```bash
# Check GPU tunnel service
systemctl status vast-tunnel.service

# Check GPU health file
cat /var/lib/mimule/gpu-health.json | python3 -m json.tool

# Manual health probe
curl -s http://127.0.0.1:11434/api/tags
```

**Fix**:
```bash
# Restart GPU tunnel
sudo systemctl restart vast-tunnel.service
sleep 5

# Verify GPU is responding
curl -s http://127.0.0.1:11434/api/tags | python3 -c "import sys,json; print('GPU OK' if json.load(sys.stdin) else 'GPU FAIL')"

# If still down, check autossh tunnel
systemctl status autossh@vast
journalctl -u autossh@vast -n 20
```

---

### Model Health Stale

**Symptoms**: Gateway routes to a model that is actually down.

**Diagnosis**:
```bash
# Check model health file age
stat /var/lib/mimule/model-health.json
# If modified > 6 hours ago, health data is stale

# Force a refresh
systemctl start model-health-check.service
sleep 10
cat /var/lib/mimule/model-health.json | python3 -m json.tool | head -30
```

**Fix**:
```bash
# Run model health check manually
node /opt/mimoun/scripts/model-health-check.mjs

# If that fails, restart LiteLLM
sudo systemctl restart litellm.service
```

---

### Build Fails

**Symptoms**: `bun run build` fails with TypeScript or Vite errors.

**Diagnosis**:
```bash
# Run typecheck first
bun run typecheck 2>&1 | head -30

# Check for common issues
# 1. Missing imports (TS2307)
# 2. Type mismatches (TS2322)
# 3. Circular dependencies (TS1175)
```

**Fix**:
```bash
# Clear Vite cache
rm -rf node_modules/.vite

# Reinstall dependencies
bun install

# Retry build
bun run build
```

If legacy components (ChatView, ConnectionScreen, Layout, SessionListPanel) fail typecheck, these are known failures from V3 → V4 migration and do not block production builds. Run `bun run build` directly.

---

### Service Starts but API Returns 500

**Symptoms**: Service is running but all API calls return `500 Internal Server Error`.

**Diagnosis**:
```bash
# Check logs for stack traces
journalctl -u control-surface.service -n 100 | grep -A 5 "Error\|Exception\|Traceback"

# Check database connectivity
sqlite3 /var/lib/builder/builder.db "SELECT count(*) FROM workflows;"

# Check disk space
df -h /
```

**Common causes**:
1. **Database corrupted** — restore from backup
2. **Disk full** — clear old logs or artifacts
3. **Secrets missing** — environment variables not set

**Fix**:
```bash
# If database corrupted
sudo systemctl stop control-surface.service
gunzip < /opt/backups/latest/builder.db.gz > /var/lib/builder/builder.db
sudo systemctl start control-surface.service

# If disk full
# Clear old backups (keep last 7 days)
find /opt/backups/ -mtime +7 -delete

# Clear old artifacts
find /var/lib/builder/artifacts/ -mtime +30 -type d -exec rm -rf {} \;

# Clear logs
journalctl --vacuum-time=7d
```

---

### Rate Limiting (429)

**Symptoms**: API returns `429 Too Many Requests`.

**Diagnosis**:
```bash
# Check rate limit headers
curl -sI https://control.techinsiderbytes.com/api/gateway/models | grep -i rate
# → X-RateLimit-Limit: 120
# → X-RateLimit-Remaining: 0
# → X-RateLimit-Reset: 1620000000
```

**Fix**: Wait for the reset window (shown in `Retry-After` header), or implement backoff in your client.

---

### Workflow Stuck in Running State

**Symptoms**: Workflow shows `status: running` but no progress.

**Diagnosis**:
```bash
# Check if the runner process is alive
ps aux | grep "builder run\|builder-agent"

# Check pass-live endpoint
curl -s http://127.0.0.1:3000/api/builder/runs/<run-id>/pass-live

# Check for deadlock in artifact directory
ls -la /var/lib/builder/artifacts/<workflow-id>/
```

**Fix**:
```bash
# Cancel the stuck run
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3000/api/builder/runs/<run-id>/cancel

# If that doesn't work, force-kill the runner
pkill -f "builder run"
```

---

## Log Locations

| Log | Location | How to access |
|---|---|---|
| Control surface | `journalctl -u control-surface.service` | `sudo journalctl -u control-surface.service -f` |
| Builder runner | `journalctl -u builder-runner.service` | `sudo journalctl -u builder-runner.service -f` |
| Autopipeline | `journalctl -u newsbites-autopipeline.service` | `sudo journalctl -u newsbites-autopipeline.service -f` |
| Model health | `/var/log/mimule/model-health.log` | `tail -f /var/log/mimule/model-health.log` |
| Backup | `journalctl -u mimule-backup.service` | `sudo journalctl -u mimule-backup.service -n 20` |
| System (all) | `/var/log/syslog` | `tail -f /var/log/syslog` |

---

## Diagnostic Commands

```bash
# Full system health check
curl -s http://127.0.0.1:3000/api/home | python3 -m json.tool

# GPU status
cat /var/lib/mimule/gpu-health.json | python3 -m json.tool

# Model status
curl -s http://127.0.0.1:3000/api/gateway/models | python3 -m json.tool

# Service status
systemctl list-units --state=running '*-service'

# Disk and memory
df -h && free -h

# Recent errors
journalctl -p err --since "1 hour ago" | tail -20

# OpenAI-compatible endpoint test
curl -s -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma4:26b","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('choices',[{}])[0].get('message',{}).get('content','ERROR'))"
```

---

## Getting Additional Help

1. **Check the health endpoint**: `curl https://control.techinsiderbytes.com/api/doctor`
2. **Export diagnostics**: `journalctl -u control-surface.service -n 200 > /tmp/diagnostics.log`
3. **Check model health**: `systemctl status model-health-check.timer`
4. **Contact**: Support with your version (`curl -s http://127.0.0.1:3000/api/version`) and diagnostics log.