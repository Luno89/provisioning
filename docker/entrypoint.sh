#!/bin/sh
set -e

SA=/var/run/secrets/kubernetes.io/serviceaccount
if [ -f "$SA/token" ] && [ -n "$KUBERNETES_SERVICE_HOST" ]; then
  KUBECONFIG_FILE="${KUBECONFIG_PATH:-/tmp/kubeconfig-provisioning-lunorica}"
  CONTEXT="${MGMT_CONTEXT:-k3d-provisioning-lunorica}"
  cat > "$KUBECONFIG_FILE" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: in-cluster
  cluster:
    server: https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}
    certificate-authority: ${SA}/ca.crt
users:
- name: in-cluster
  user:
    tokenFile: ${SA}/token
contexts:
- name: ${CONTEXT}
  context:
    cluster: in-cluster
    user: in-cluster
current-context: ${CONTEXT}
EOF
  chmod 600 "$KUBECONFIG_FILE"
  mkdir -p "$HOME/.kube"
  cp "$KUBECONFIG_FILE" "$HOME/.kube/config"
  export KUBECONFIG="$KUBECONFIG_FILE"
  export KUBECONFIG_PATH="$KUBECONFIG_FILE"
fi

cd /app/apps/backend
case "${1:-backend}" in
  backend) exec npx tsx src/index.ts ;;
  worker-engine) exec npx tsx src/worker-engine.ts ;;
  worker-cluster) exec npx tsx src/worker-cluster.ts ;;
  worker-host) exec npx tsx src/worker-host.ts ;;
  seed) exec npx tsx src/scripts/seed-all.ts ;;
  platform-services) exec bash /app/scripts/instance/platform-services.sh ;;
  self-upgrade) exec bash /app/scripts/instance/self-upgrade.sh ;;
  *) exec "$@" ;;
esac
