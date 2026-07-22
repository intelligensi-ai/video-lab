#!/usr/bin/env bash
set -euo pipefail

# Bootstrap helper for a Lambda Labs Ubuntu GPU instance that will run the
# Deploy Studio/LTX Sulphur runtime behind a local HTTP port.
#
# Usage on the instance:
#   sudo DEPLOY_STUDIO_START_COMMAND='docker compose up -d' ./bootstrap-deploy-studio.sh
#
# This script intentionally does not install Deploy Studio itself because that
# package/image is owned outside this repo. It prepares the host, systemd unit,
# firewall baseline, and health-check path expected by Video Lab.

APP_DIR="${APP_DIR:-/opt/video-lab/deploy-studio}"
RUNTIME_PORT="${RUNTIME_PORT:-7860}"
START_COMMAND="${DEPLOY_STUDIO_START_COMMAND:-}"
SERVICE_NAME="${SERVICE_NAME:-video-lab-deploy-studio}"

if [[ -z "${START_COMMAND}" ]]; then
  echo "DEPLOY_STUDIO_START_COMMAND is required" >&2
  exit 1
fi

install -d -m 0755 "${APP_DIR}"

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl ca-certificates jq ufw
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH
  ufw allow "${RUNTIME_PORT}/tcp"
  ufw --force enable
fi

cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Video Lab Deploy Studio LTX runtime
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${APP_DIR}
RemainAfterExit=yes
ExecStart=/usr/bin/env bash -lc '${START_COMMAND}'
ExecStop=/usr/bin/env bash -lc 'docker compose down || true'
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

cat <<EOF
Prepared ${SERVICE_NAME}.

Next:
1. Place the Deploy Studio project, compose file, or launcher under ${APP_DIR}.
2. Start it with: sudo systemctl start ${SERVICE_NAME}
3. Confirm local health: curl http://127.0.0.1:${RUNTIME_PORT}/health
4. Put TLS/auth in front of it before using it from Firebase.
EOF
