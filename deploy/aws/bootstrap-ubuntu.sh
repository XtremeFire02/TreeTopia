#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-ubuntu}"
APP_DIR="${APP_DIR:-/opt/treetopia}"
DATA_DIR="${DATA_DIR:-/var/lib/treetopia}"
DOMAIN="${DOMAIN:-_}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git gnupg nginx

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

mkdir -p "$APP_DIR/releases" "$DATA_DIR/worlds"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

cat >/etc/systemd/system/treetopia.service <<SERVICE
[Unit]
Description=TreeTopia Node game server
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/current
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=DATA_DIR=$DATA_DIR
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
SERVICE

cat >/etc/nginx/sites-available/treetopia <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
NGINX

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/treetopia /etc/nginx/sites-enabled/treetopia

systemctl daemon-reload
systemctl enable treetopia
systemctl enable nginx
nginx -t
systemctl restart nginx

cat <<EOF
TreeTopia host bootstrap complete.

Next:
1. Add GitHub Actions secrets: AWS_HOST, AWS_USER, AWS_SSH_KEY.
2. Run the "Deploy to AWS EC2" workflow from GitHub Actions.
3. After first deploy, check: sudo systemctl status treetopia
EOF
