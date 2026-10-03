#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTEXT="k3d-provisioning-lunorica"
KUBECTL="${ROOT}/bin/kubectl"
[ -x "$KUBECTL" ] && "$KUBECTL" version --client >/dev/null 2>&1 || KUBECTL="kubectl"

"$KUBECTL" --context "$CONTEXT" apply -f "${ROOT}/k8s/koala-egress/" \
  || echo "  ⚠️  Egress proxy apply failed — sandboxes will not be able to install packages"
"$KUBECTL" --context "$CONTEXT" apply -f "${ROOT}/k8s/searxng/" \
  || echo "  ⚠️  SearXNG apply failed — web_search will fall back to DuckDuckGo"
"$KUBECTL" --context "$CONTEXT" apply -f "${ROOT}/k8s/crawl4ai/" \
  || echo "  ⚠️  Crawl4AI apply failed — fetch_web_page will fall back to raw HTML stripping"

bash "${ROOT}/scripts/ensure-gitea.sh"
bash "${ROOT}/scripts/ensure-verdaccio.sh"
bash "${ROOT}/scripts/ensure-infisical.sh"
