#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:?usage: cdktf-bindings.sh <checkout>}"
INFRA="$REPO_DIR/packages/cdktf-infra"
TERRAFORM="${TERRAFORM:-$REPO_DIR/bin/terraform}"
CDKTF="${CDKTF:-$REPO_DIR/node_modules/.bin/cdktf}"
[ -x "$CDKTF" ] || { echo "no cdktf at ${CDKTF}; run npm ci in ${REPO_DIR} first" >&2; exit 1; }

missing=()
while IFS= read -r provider; do
  name="${provider%@*}"; name="${name##*/}"
  [ -d "$INFRA/.gen/providers/$name" ] || missing+=("$provider")
done < <(node -e 'for (const p of require(process.argv[1]).terraformProviders) console.log(p)' "$INFRA/cdktf.json")

[ "${#missing[@]}" -eq 0 ] && exit 0

echo "the checkout has no CDKTF bindings for ${missing[*]}; generating them"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
node -e 'console.log(JSON.stringify({ language: "typescript", app: "true", projectId: "cdktf-infra", sendCrashReports: "false", terraformProviders: process.argv.slice(1) }))' "${missing[@]}" > "$work/cdktf.json"
(cd "$work" && TERRAFORM_BINARY_NAME="$TERRAFORM" "$CDKTF" get --output .gen >/dev/null)
for provider in "${missing[@]}"; do
  name="${provider%@*}"; name="${name##*/}"
  [ -d "$work/.gen/providers/$name" ] || { echo "cdktf get wrote no bindings for ${provider}" >&2; exit 1; }
done
mkdir -p "$INFRA/.gen/providers"
cp -r "$work/.gen/providers/." "$INFRA/.gen/providers/"
echo "CDKTF bindings generated for ${missing[*]}"
