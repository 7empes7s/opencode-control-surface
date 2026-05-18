# Control Surface — Installation Guide

## Quick Install (curl)

```bash
curl -fsSL https://releases.control-surface.dev/install.sh | bash
```

This will:
- Install Bun if not present
- Download the latest `control-surface` binary to `/usr/local/bin/`
- Create the data directory at `/var/lib/control-surface`
- Write default config to `/etc/control-surface/config.yaml`
- Install and start the `control-surface.service` systemd unit

After installation, visit **http://localhost:3000** to complete setup.

### Manage the service

```bash
systemctl start control-surface   # start
systemctl stop control-surface    # stop
systemctl restart control-surface # restart
journalctl -u control-surface     # view logs
```

---

## Docker

```bash
git clone https://github.com/your-org/control-surface.git
cd control-surface
docker compose -f installer/docker/compose.yaml up -d
```

The container exposes port 3000 and persists data in a `control-data` Docker volume.

---

## Air-Gapped / Manual Install

1. Copy the `control-surface` binary to `/usr/local/bin/`
2. Create data directory: `mkdir -p /var/lib/control-surface`
3. Write config to `/etc/control-surface/config.yaml`
4. Copy `installer/systemd/control-surface.service` to `/etc/systemd/system/`
5. Run: `systemctl daemon-reload && systemctl enable --now control-surface`