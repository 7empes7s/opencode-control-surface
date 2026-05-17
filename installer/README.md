# TIB Builder — Installation Guide

## Quick Install (curl)

```bash
curl -fsSL https://releases.tib-builder.dev/install.sh | bash
```

This will:
- Install Bun if not present
- Download the latest `tib-builder` binary to `/usr/local/bin/`
- Create the data directory at `/var/lib/tib-builder`
- Write default config to `/etc/tib-builder/config.yaml`
- Install and start the `tib-builder.service` systemd unit

After installation, visit **http://localhost:3000** to complete setup.

### Manage the service

```bash
systemctl start tib-builder   # start
systemctl stop tib-builder    # stop
systemctl restart tib-builder # restart
journalctl -u tib-builder     # view logs
```

---

## Docker

```bash
git clone https://github.com/your-org/tib-builder.git
cd tib-builder
docker compose -f installer/docker/compose.yaml up -d
```

The container exposes port 3000 and persists data in a `tib-data` Docker volume.

---

## Air-Gapped / Manual Install

1. Copy the `tib-builder` binary to `/usr/local/bin/`
2. Create data directory: `mkdir -p /var/lib/tib-builder`
3. Write config to `/etc/tib-builder/config.yaml`
4. Copy `installer/systemd/tib-builder.service` to `/etc/systemd/system/`
5. Run: `systemctl daemon-reload && systemctl enable --now tib-builder`