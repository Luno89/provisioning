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
apply_services() {
  if [ "${POOL:-}" = true ]; then
    for manifest in "$1"/*.yaml; do echo ---; cat "$manifest"; done | sed -e 's/type: NodePort/type: ClusterIP/' -e '/nodePort:/d' | "$KUBECTL" --context "$CONTEXT" apply -f -
  else
    "$KUBECTL" --context "$CONTEXT" apply -f "$1"
  fi
}

apply_services "${ROOT}/k8s/searxng/" \
  || echo "  ⚠️  SearXNG apply failed — web_search will fall back to DuckDuckGo"
apply_services "${ROOT}/k8s/crawl4ai/" \
  || echo "  ⚠️  Crawl4AI apply failed — fetch_web_page will fall back to raw HTML stripping"

bash "${ROOT}/scripts/ensure-gitea.sh"
bash "${ROOT}/scripts/ensure-verdaccio.sh"
bash "${ROOT}/scripts/ensure-infisical.sh"
