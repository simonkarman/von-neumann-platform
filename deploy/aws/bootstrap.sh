#!/bin/bash
# Executed only on the dedicated CloudFormation-created EC2 host.
set -euo pipefail
exec > >(tee -a /var/log/von-neumann-bootstrap.log) 2>&1
cd /opt/von-neumann
dnf install -y docker git iptables jq

# Wait for CloudFormation's separately retained volume attachment.
serial="${DATA_VOLUME_ID//-/}"
device=""
for attempt in $(seq 1 120); do
  device=$(lsblk -ndo PATH,SERIAL | awk -v serial="$serial" '$2 == serial {print $1}')
  test -n "$device" && break
  sleep 5
done
test -b "$device"
filesystem=$(blkid -o value -s TYPE "$device" || true)
if test -z "$filesystem"; then mkfs.ext4 "$device"; else test "$filesystem" = ext4; fi
mkdir -p /srv/von-neumann
uuid=$(blkid -o value -s UUID "$device")
if ! grep -q "$uuid" /etc/fstab; then printf 'UUID=%s /srv/von-neumann ext4 defaults,nofail 0 2\n' "$uuid" >> /etc/fstab; fi
mountpoint -q /srv/von-neumann || mount /srv/von-neumann
mkdir -p /etc/docker /etc/von-neumann /usr/local/lib/docker/cli-plugins
printf '%s\n' '{"data-root":"/srv/von-neumann/docker","log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}' > /etc/docker/daemon.json
mkdir -p /etc/systemd/system/docker.service.d
install -m 644 deploy/aws/docker-storage.conf /etc/systemd/system/docker.service.d/storage.conf
systemctl daemon-reload

# Docker 26+ is required for isolated volume-subpath mounts.
major=$(docker --version | awk '{split($3,v,"."); print v[1]}')
if test "$major" -lt 26; then
  curl -fL --retry 3 https://download.docker.com/linux/static/stable/aarch64/docker-29.0.4.tgz -o /tmp/vn-docker.tgz
  tar -xzf /tmp/vn-docker.tgz -C /tmp
  install /tmp/docker/* /usr/bin/
fi
curl -fL --retry 3 https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-aarch64 -o /usr/local/lib/docker/cli-plugins/docker-compose
curl -fL --retry 3 https://github.com/docker/buildx/releases/download/v0.26.1/buildx-v0.26.1.linux-arm64 -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod 755 /usr/local/lib/docker/cli-plugins/docker-*
systemctl enable --now docker

# The metadata endpoint is available to the trusted backend only, never sessions.
install -m 755 deploy/aws/session-firewall.sh /usr/local/sbin/von-neumann-session-firewall
install -m 644 deploy/aws/session-firewall.service /etc/systemd/system/von-neumann-session-firewall.service
systemctl daemon-reload
systemctl enable --now von-neumann-session-firewall

# This env file contains public configuration and secret ARNs, never secret values.
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
export DOCKER_GID
for key in DOMAIN AWS_REGION ADMIN_PASSWORD_SECRET_ARN SESSION_SECRET_ARN AWS_CONNECTOR_SECRET_ARN AI_CONFIG_SECRET_ARN CLOUDWATCH_LOG_GROUP DOCKER_GID; do
  printf '%s=%s\n' "$key" "${!key}"
done > /etc/von-neumann/runtime.env
chmod 600 /etc/von-neumann/runtime.env
docker compose --env-file /etc/von-neumann/runtime.env -f deploy/aws/compose.yaml --profile build build
docker compose --env-file /etc/von-neumann/runtime.env -f deploy/aws/compose.yaml up -d platform proxy
install -m 644 deploy/aws/application.service /etc/systemd/system/von-neumann.service
systemctl daemon-reload
systemctl enable --now von-neumann
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/healthz; then touch /var/lib/von-neumann-ready; exit 0; fi
  sleep 5
done
exit 1
