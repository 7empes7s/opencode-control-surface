# Cloud Tier Infrastructure

This directory contains the infrastructure-as-code and provisioning scripts for the **Cloud Tier** of the OpenCode Control Surface.

## Architecture Overview

| Component | Spec | Role |
|---|---|---|
| **Hetzner CX22** | 2 vCPU, 4 GB RAM, 40 GB NVMe | Lightweight VPS for the Control Surface web UI and API |
| **Caddy** | Reverse proxy | TLS termination, static asset serving, API routing |
| **cloudflared** | Cloudflare Tunnel | Secure ingress without public IP exposure |
| **control-surface binary** | Bun-compiled standalone | Main application server (dashboard, API, builder) |

## Network Flow

```
User ──HTTPS──► Cloudflare Edge ──Tunnel──► cloudflared ──HTTP──► Caddy (:80)
                                                                └──► control-surface (:3000)
```

## Quick Start

1. Copy `customer.env.template` to `customer.env` and fill in values.
2. Run `./provision.sh` on a fresh Hetzner CX22 (Ubuntu 24.04).
3. The script installs Bun, Caddy, cloudflared, compiles the binary, and starts services.

## Files

| File | Purpose |
|---|---|
| `README.md` | This file — architecture and quick-start |
| `provision.sh` | One-shot provisioning script |
| `customer.env.template` | Required environment variables template |

## Notes

- The Cloud Tier runs the **Solo** license tier by default.
- For **Team** or **Enterprise** tiers, contact licensing.
- Telemetry is opt-in; set `TELEMETRY_OPT_IN=1` to enable.
