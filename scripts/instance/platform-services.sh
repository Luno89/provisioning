#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTEXT="k3d-provisioning-lunorica"
KUBECTL="${ROOT}/bin/kubectl"
[ -x "$KUBECTL" ] && "$KUBECTL" version --client >/dev/null 2>&1 || KUBECTL="kubectl"

"$KUBECTL" --context "$CONTEXT" apply -f "${ROOT}/k8s/koala-egress/" \
  || echo "  ⚠️  Egress proxy apply failed — sandboxes will not be able to install packages"
"$KUBECTL" --context "$CONTEXT" -n koala-egress get configmap egress-grants >/dev/null 2>&1 \
  || "$KUBECTL" --context "$CONTEXT" apply -f "${ROOT}/k8s/koala-egress-seed/" \
  || echo "  ⚠️  The egress proxy's grants could not be started — sandboxes will reach only the package registries"
EGRESS_CONFIG="$(sha256sum "${ROOT}/k8s/koala-egress/egress-proxy.yaml" | cut -c1-16)"
"$KUBECTL" --context "$CONTEXT" -n koala-egress patch deployment egress-proxy --type merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"koala.dev/egress-config\":\"${EGRESS_CONFIG}\"}}}}}" >/dev/null \
  || echo "  ⚠️  The egress proxy was not restarted onto its new rules — run: kubectl -n koala-egress rollout restart deploy/egress-proxy"
services() {
  if [ -z "${POD_NAMESPACE:-}" ]; then
    for manifest in "$1"/*.yaml; do echo ---; cat "$manifest"; done
    return
  fi
  for manifest in "$1"/*.yaml; do echo ---; cat "$manifest"; done | sed -e 's/type: NodePort/type: ClusterIP/' -e '/nodePort:/d'
  cat <<POLICY
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: koala-only
  namespace: $2
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${POD_NAMESPACE}
POLICY
}

services "${ROOT}/k8s/searxng" searxng | "$KUBECTL" --context "$CONTEXT" apply -f -
: "${CRAWL4AI_API_TOKEN:?CRAWL4AI_API_TOKEN is not set: Crawl4AI reads pages only for a caller holding it, and the instance chart makes it}"
case "$CRAWL4AI_API_TOKEN" in *[!A-Za-z0-9]*) echo "CRAWL4AI_API_TOKEN holds more than letters and digits, which the instance chart never makes" >&2; exit 1 ;; esac
services "${ROOT}/k8s/crawl4ai" crawl4ai | sed "s|\${CRAWL4AI_API_TOKEN}|${CRAWL4AI_API_TOKEN}|" | "$KUBECTL" --context "$CONTEXT" apply -f -
CRAWL4AI_TOKEN_STAMP="$(printf '%s' "$CRAWL4AI_API_TOKEN" | sha256sum | cut -c1-16)"
"$KUBECTL" --context "$CONTEXT" -n crawl4ai patch deployment crawl4ai --type merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"koala.dev/token\":\"${CRAWL4AI_TOKEN_STAMP}\"}}}}}" >/dev/null

bash "${ROOT}/scripts/ensure-gitea.sh"
bash "${ROOT}/scripts/ensure-verdaccio.sh"
bash "${ROOT}/scripts/ensure-infisical.sh"
