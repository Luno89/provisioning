#!/usr/bin/env bash
set -euo pipefail

api() { curl -fsS -H "X-Instance-Id: ${INSTANCE_ID}" -H "Authorization: Bearer ${INSTANCE_CREDENTIAL}" "$@"; }
field() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }
report() {
  node -e 'console.log(JSON.stringify({ status: process.argv[1], detail: process.argv[2] }))' "$1" "$2" \
    | api -X POST -H 'Content-Type: application/json' --data-binary @- "${ROOT_URL}/api/instances/status" >/dev/null || true
}

RELEASE="$(api "${ROOT_URL}/api/instances/release")"
WANT="$(printf '%s' "$RELEASE" | field imageTag)"
CHART_URL="$(printf '%s' "$RELEASE" | field chartUrl)"

if [ "$WANT" = "$CURRENT_IMAGE_TAG" ]; then
  report ready "Running ${WANT}"
  exit 0
fi

report installing "Upgrading from ${CURRENT_IMAGE_TAG} to ${WANT}"
curl -fsSL "$CHART_URL" -o /tmp/instance-chart.tgz
if helm upgrade "$RELEASE_NAME" /tmp/instance-chart.tgz -n "$RELEASE_NAMESPACE" --reuse-values --set image.tag="$WANT" --wait --timeout "${UPGRADE_TIMEOUT:-20m}"; then
  report ready "Upgraded to ${WANT}"
else
  helm rollback "$RELEASE_NAME" -n "$RELEASE_NAMESPACE" --wait --timeout "${UPGRADE_TIMEOUT:-20m}" || true
  report failed "The upgrade to ${WANT} failed, so it was rolled back to ${CURRENT_IMAGE_TAG}"
  exit 1
fi
