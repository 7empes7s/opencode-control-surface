#!/bin/bash
set -e

echo "=== TIB Builder Installer ==="

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

# Download tib-builder binary
echo "Installing tib-builder..."
mkdir -p /usr/local/bin
curl -fsSL https://releases.tib-builder.dev/latest/tib-builder-linux-x64 -o /usr/local/bin/tib-builder
chmod +x /usr/local/bin/tib-builder

# Create data directory
echo "Creating data directory..."
mkdir -p /var/lib/tib-builder

# Create config
echo "Creating config..."
mkdir -p /etc/tib-builder
cat > /etc/tib-builder/config.yaml << 'EOF'
port: 3000
data_dir: /var/lib/tib-builder
operator_token: CHANGEME
EOF

# Write and enable systemd unit
echo "Installing systemd service..."
cat > /etc/systemd/system/tib-builder.service << 'EOF'
[Unit]
Description=TIB Builder Platform
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/tib-builder
EnvironmentFile=-/etc/tib-builder/config.env
WorkingDirectory=/var/lib/tib-builder
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tib-builder
systemctl start tib-builder

echo ""
echo "=== Installation Complete ==="
echo "Dashboard reachable at http://localhost:3000 — open to complete setup"
echo ""
echo "Use the following commands to manage the service:"
echo "  systemctl start tib-builder   # start"
echo "  systemctl stop tib-builder    # stop"
echo "  systemctl restart tib-builder # restart"
echo "  journalctl -u tib-builder      # view logs"