#!/usr/bin/env bash
# provision.sh — One-shot provision a Hetzner CX22 for Cloud Tier
# Usage: ./provision.sh <hetzner-api-token> <server-name>
set -euo pipefail

HCLOUD_TOKEN="${1:-}"
SERVER_NAME="${2:-opencode-cloud-tier}"
SSH_KEY="${HCLOUD_SSH_KEY:-~/.ssh/id_ed25519.pub}"

echo "=== Cloud Tier Provisioning ==="
echo "Server name: $SERVER_NAME"

# --- 1. Create server via hcloud CLI ---
if ! command -v hcloud &>/dev/null; then
  echo "Installing hcloud CLI..."
  curl -sL https://github.com/hetznercloud/cli/releases/latest/download/hcloud-linux-amd64.tar.gz \
    | tar -xz -C /tmp
  sudo mv /tmp/hcloud /usr/local/bin/hcloud
fi

SERVER_IP=$(hcloud server create \
  --name "$SERVER_NAME" \
  --type cx22 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key "$SSH_KEY" \
  --datacenter nbg1-dc3 \
  -o format='{{ .PublicNet.IPv4.IP }}' \
  --poll-interval 5s)

echo "Server created: $SERVER_IP"

# --- 2. Wait for SSH ---
echo "Waiting for SSH..."
for i in {1..30}; do
  if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "root@$SERVER_IP" true 2>/dev/null; then
    break
  fi
  sleep 5
done

# --- 3. Remote setup ---
echo "Running remote setup..."
ssh -o StrictHostKeyChecking=no "root@$SERVER_IP" bash -s <<'REMOTESCRIPT'
set -euo pipefail

apt-get update
apt-get install -y curl unzip git

# Install Bun
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# Install Caddy
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb || apt-get install -f -y

# Create app directory
mkdir -p /opt/opencode-control-surface

echo "=== Remote setup complete ==="
REMOTESCRIPT

# --- 4. Copy code and env ---
echo "Uploading application..."
rsync -az --exclude=node_modules --exclude=.git \
  ./ "root@$SERVER_IP:/opt/opencode-control-surface/"

# Copy env if present
if [ -f ./customer.env ]; then
  scp ./customer.env "root@$SERVER_IP:/opt/opencode-control-surface/.env"
fi

# --- 5. Build and start ---
ssh -o StrictHostKeyChecking=no "root@$SERVER_IP" bash -s <<'REMOTESCRIPT'
set -euo pipefail
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
cd /opt/opencode-control-surface
bun install
bun run build

# Write Caddyfile
cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
  root * /opt/opencode-control-surface/dist
  file_server
  reverse_proxy /api/* localhost:3000
  reverse_proxy /ws/* localhost:3000
}
EOF
systemctl reload caddy

# Write systemd service
cat > /etc/systemd/system/control-surface.service <<'EOF'
[Unit]
Description=OpenCode Control Surface
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-control-surface
EnvironmentFile=/opt/opencode-control-surface/.env
ExecStart=/root/.bun/bin/bun run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now control-surface

echo "=== Provisioning complete ==="
REMOTESCRIPT

echo "Cloud Tier provisioned at: $SERVER_IP"
