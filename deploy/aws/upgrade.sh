#!/bin/bash
set -euo pipefail
cd /opt/von-neumann
test -f /var/lib/von-neumann-ready
mkdir -p /etc/systemd/system/docker.service.d
install -m 644 deploy/aws/docker-storage.conf /etc/systemd/system/docker.service.d/storage.conf
install -m 755 deploy/aws/session-firewall.sh /usr/local/sbin/von-neumann-session-firewall
install -m 644 deploy/aws/session-firewall.service /etc/systemd/system/von-neumann-session-firewall.service
install -m 644 deploy/aws/application.service /etc/systemd/system/von-neumann.service
systemctl daemon-reload
systemctl restart von-neumann-session-firewall
docker compose --env-file /etc/von-neumann/runtime.env -f deploy/aws/compose.yaml --profile build build
docker compose --env-file /etc/von-neumann/runtime.env -f deploy/aws/compose.yaml up -d --force-recreate platform proxy
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/healthz; then exit 0; fi
  sleep 2
done
exit 1
