#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/nowrinkles}"
ADMIN_KUBECONFIG="${ADMIN_KUBECONFIG:-/var/lib/rancher/k3s-provisioning-lunorica/kubeconfig.yaml}"
BACKEND_KUBECONFIG=/etc/koala/backend-kubeconfig

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
die()  { echo -e "  ${RED}❌${NC} $1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: this writes systemd units and makes the koala user."

id koala &>/dev/null || useradd --system --home-dir /var/lib/koala --shell /usr/sbin/nologin koala
cat > /etc/tmpfiles.d/koala.conf <<CONF
d /run/koala-caddy 0750 root koala -
d /var/log/koala-caddy 0750 root koala -
CONF
systemd-tmpfiles --create /etc/tmpfiles.d/koala.conf
install -d -m 755 /etc/koala
install -d -m 700 -o koala -g koala "${REPO_DIR}/apps/backend/data"
chown -R koala:koala "${REPO_DIR}/apps/backend/data"
chown koala:koala "${REPO_DIR}/apps/backend/.env"
chmod 600 "${REPO_DIR}/apps/backend/.env"
ok "the backend runs as koala, which owns its data and env and may enter Caddy's admin and log folders"

if [ -s "$ADMIN_KUBECONFIG" ]; then
  KUBECTL=("${REPO_DIR}/bin/kubectl" --kubeconfig "$ADMIN_KUBECONFIG")
  "${KUBECTL[@]}" apply -f "${REPO_DIR}/k8s/root-backend/" >/dev/null
  TOKEN=""
  for _ in $(seq 1 60); do
    TOKEN="$("${KUBECTL[@]}" -n kube-system get secret koala-backend-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)"
    [ -n "$TOKEN" ] && break
    sleep 1
  done
  [ -n "$TOKEN" ] || die "the cluster gave the koala-backend account no token"
  SERVER="$("${KUBECTL[@]}" config view --raw -o jsonpath='{.clusters[0].cluster.server}')"
  CA="$("${KUBECTL[@]}" config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
  ( umask 077; cat > "$BACKEND_KUBECONFIG" <<CONF
apiVersion: v1
kind: Config
clusters:
  - name: root
    cluster:
      server: ${SERVER}
      certificate-authority-data: ${CA}
users:
  - name: koala-backend
    user:
      token: ${TOKEN}
contexts:
  - name: koala-backend
    context:
      cluster: root
      user: koala-backend
current-context: koala-backend
CONF
  )
  chown koala:koala "$BACKEND_KUBECONFIG"
  chmod 600 "$BACKEND_KUBECONFIG"
  ok "the backend reaches the cluster as koala-backend: the pool's Prometheus, and pool namespaces only"
else
  warn "there is no cluster yet, so the backend has no cluster account until this runs again"
fi

cat > /etc/systemd/system/nowrinkles.service <<UNIT
[Unit]
Description=No Wrinkles platform: the backend
After=docker.service network-online.target nowrinkles-workers.service
Wants=nowrinkles-workers.service

[Service]
Type=simple
User=koala
Group=koala
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/npm run start -w apps/backend
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=HOME=/var/lib/koala
Environment=CADDY_ADMIN_SOCKET=/run/koala-caddy/admin.sock
Environment=CADDY_LOG=/var/log/koala-caddy/caddy.log
Environment=POOL_KUBECONFIG=${BACKEND_KUBECONFIG}
Environment=GIT_CONFIG_COUNT=1
Environment=GIT_CONFIG_KEY_0=safe.directory
Environment=GIT_CONFIG_VALUE_0=${REPO_DIR}
StateDirectory=koala
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ReadWritePaths=${REPO_DIR}/apps/backend/data /run/koala-caddy
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/nowrinkles-workers.service <<UNIT
[Unit]
Description=No Wrinkles platform: the host, cluster and engine workers
After=docker.service network-online.target
Requires=docker.service
PartOf=nowrinkles.service

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/npx concurrently --kill-others "npm run start:worker -w apps/backend" "npm run start:worker:cluster -w apps/backend" "npm run start:worker:engine -w apps/backend"
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable nowrinkles.service nowrinkles-workers.service >/dev/null 2>&1
ok "nowrinkles.service runs the backend as koala, sandboxed; nowrinkles-workers.service runs the workers as root and restarts with it"
