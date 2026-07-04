# Install

**Time**: under 10 minutes on a bare host.
**Prerequisites**: [Bun](https://bun.sh) 1.x. `git` is only needed if you don't already have a checkout. `curl` is optional (handy for probing `/health` afterward).

`install.sh` (repo root) is the one command that takes a bare host to a running login screen. It is idempotent — safe to re-run — and never runs `systemctl` or installs system packages on your behalf.

---

## Quick install

```bash
git clone https://github.com/7empes7s/opencode-control-surface.git
cd opencode-control-surface
./install.sh
```

This will:

1. Check prerequisites (`bun`, `git`, `curl`) and print an honest install hint for anything missing — it never installs system packages for you.
2. Use the current checkout (or clone one, if you ran the script standalone — see below).
3. `bun install` + `bun run build`.
4. Generate a strong random `OPERATOR_TOKEN` (if one doesn't already exist) and write it, along with `PORT`, `DASHBOARD_DB=1`, and `DASHBOARD_DB_PATH`, to `./control-surface.env` (`chmod 600`). **The token is printed once** — store it immediately, it is not shown again.
5. Start the server in the foreground on `:3000` (Ctrl+C to stop).

Once it's up:

```bash
curl http://localhost:3000/health
# {"ok":true,...}
```

Open `http://<host>:3000` in a browser and sign in with the operator token from step 4. On a genuinely first-run install you'll see a **first-run setup banner** on the home page — name your installation and click "Finish setup" (or "Later" to skip for now; it reappears next time until you complete it).

---

## Options

```
./install.sh --check              # dry run: validate prerequisites, print the plan, make no changes
./install.sh --dir /opt/my-cs     # install into a specific directory (clones there if not already a checkout)
./install.sh --env-file /etc/control-surface/secrets.env
./install.sh --port 8080
./install.sh --systemd            # print a systemd unit to stdout instead of starting in the foreground
./install.sh --systemd unit.service   # ...or write it to a file
```

`install.sh` **never calls `systemctl`**. `--systemd` only ever emits unit text — installing and enabling it is your own step:

```bash
./install.sh --systemd /tmp/control-surface.service
sudo cp /tmp/control-surface.service /etc/systemd/system/control-surface.service
sudo systemctl daemon-reload && sudo systemctl enable --now control-surface
```

---

## Re-running / upgrading

`install.sh` is idempotent:

- If `./control-surface.env` already has an `OPERATOR_TOKEN`, it's reused — the token is not regenerated or reprinted.
- `bun install` / `bun run build` are no-ops (fast) when nothing changed.
- Re-run any time (e.g. after `git pull`) to rebuild and restart.

---

## First-run setup

`GET /api/setup/state` reports `{ needsSetup: true }` until an operator names the installation (`POST /api/setup/complete { "tenantName": "..." }`, auth required). This only fires for an install that has never been used — an existing, already-active database is never asked to "set up" again, even if the wizard is deployed to it after the fact.

---

## Air-gapped / manual install

1. Copy this repo to the target host by whatever means you have (no `git`/network required once the files are there).
2. `cd` into it and run `./install.sh --dir "$(pwd)"` — it will detect the existing checkout and skip cloning.
3. Everything else (build, token, env file, start) proceeds the same as the quick install above.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing prerequisite: bun` | `curl -fsSL https://bun.sh/install | bash`, then re-run `install.sh` |
| `Missing prerequisite: git` (only when cloning is needed) | `apt-get install -y git` (Debian/Ubuntu) or `brew install git` (macOS) |
| Forgot the operator token | Read it from `control-surface.env` (`chmod 600` — you'll need appropriate privileges) |
| Need a different port | `./install.sh --port 8080`, or edit `PORT=` in the env file and restart |
