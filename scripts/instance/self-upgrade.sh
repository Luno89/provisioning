#!/usr/bin/env bash
set -euo pipefail

api() { curl -fsS -H "X-Instance-Id: ${INSTANCE_ID}" -H "Authorization: Bearer ${INSTANCE_CREDENTIAL}" "$@"; }
field() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]] ?? ""))' "$1"; }
report() {
  node -e 'console.log(JSON.stringify({ status: process.argv[1], detail: process.argv[2], ...(process.argv[3] ? { imageTag: process.argv[3] } : {}) }))' "$1" "$2" "${3:-}" \
    | api -X POST -H 'Content-Type: application/json' --data-binary @- "${ROOT_URL}/api/instances/status" >/dev/null || true
}

RELEASE="$(api "${ROOT_URL}/api/instances/release")"
WANT="$(printf '%s' "$RELEASE" | field imageTag)"
CHART_URL="$(printf '%s' "$RELEASE" | field chartUrl)"
DIGEST="$(printf '%s' "$RELEASE" | field digest)"
CHART_SHA256="$(printf '%s' "$RELEASE" | field chartSha256)"

if [ "$WANT" = "$CURRENT_IMAGE_TAG" ]; then
  report ready "Running ${WANT}" "$WANT"
  exit 0
fi

report installing "Upgrading from ${CURRENT_IMAGE_TAG} to ${WANT}"
CHART="$(mktemp)"
trap 'rm -f "$CHART"' EXIT
curl -fsSL "$CHART_URL" -o "$CHART"
if [ -n "$CHART_SHA256" ] && ! printf '%s  %s\n' "$CHART_SHA256" "$CHART" | sha256sum -c --quiet - >/dev/null 2>&1; then
  report failed "The chart root sent for ${WANT} is not the one it released (its sha256 differs), so nothing was changed"
  exit 1
fi
if [ -n "$DIGEST" ] && ! [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  report failed "Root named ${DIGEST} as the image of ${WANT}, which is not a digest, so nothing was changed"
  exit 1
fi
if helm upgrade "$RELEASE_NAME" "$CHART" -n "$RELEASE_NAMESPACE" --reset-then-reuse-values --set image.tag="$WANT" --set-string image.digest="$DIGEST" --wait --timeout "${UPGRADE_TIMEOUT:-20m}"; then
  report ready "Upgraded to ${WANT}" "$WANT"
else
  helm rollback "$RELEASE_NAME" -n "$RELEASE_NAMESPACE" --wait --timeout "${UPGRADE_TIMEOUT:-20m}" || true
  report failed "The upgrade to ${WANT} failed, so it was rolled back to ${CURRENT_IMAGE_TAG}"
  exit 1
fi
