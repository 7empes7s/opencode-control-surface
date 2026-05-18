#!/bin/bash
set -e

echo "=== Control Surface Installer ==="

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -r)" != "Linux" ]; then
  echo "This script only supports Ubuntu/Debian Linux."
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root: sudo $0"
  exit 1
fi

echo "Detected OS: Ubuntu/Debian Linux"

# Install Bun if not present
if ! command -v bun &> /dev/null; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
else
  echo "Bun already installed"
fi

# Download control-surface binary
echo "Installing control-surface..."
mkdir -p /usr/local/bin
curl -fsSL https://releases.control-surface.dev/latest/control-surface-linux-x64 -o /usr/local/bin/control-surface
chmod +x /usr/local/bin/control-surface

# Create data directory
echo "Creating data directory..."
mkdir -p /var/lib/control-surface

# Create config
echo "Creating config..."
mkdir -p /etc/control-surface
cat > /etc/control-surface/config.yaml << 'EOF'
port: 3000
data_dir: /var/lib/control-surface
operator_token: CHANGEME
EOF

# Write and enable systemd unit
echo "Installing systemd service..."
cat > /etc/systemd/system/control-surface.service << 'EOF'
[Unit]
Description=Control Surface Platform
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/control-surface
EnvironmentFile=-/etc/control-surface/config.env
WorkingDirectory=/var/lib/control-surface
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable control-surface
systemctl start control-surface

echo ""
echo "=== Installation Complete ==="
echo "Dashboard reachable at http://localhost:3000 — open to complete setup"
echo ""
echo "Use the following commands to manage the service:"
echo "  systemctl start control-surface   # start"
echo "  systemctl stop control-surface    # stop"
echo "  systemctl restart control-surface # restart"
echo "  journalctl -u control-surface      # view logs"