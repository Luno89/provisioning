#!/usr/bin/env bash
set -euo pipefail

REPO="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
TOOLS="${CI_TOOLS:-${REPO}/.ci-tools}"
PINS="${REPO}/dependencies.pins.json"
[ -f "$PINS" ] || { echo "${PINS} is missing; it holds every tool's version and checksum" >&2; exit 1; }

pin() { node "${REPO}/scripts/pin.mjs" "$1"; }

usage() {
  cat <<EOF >&2
bash scripts/ci-tools.sh <tool>   fetches the pinned tool into .ci-tools/ when it is missing, checks its sha256, and prints its path
tools: $(node "${REPO}/scripts/pin.mjs" --names)
EOF
  exit 2
}

name="${1:-}"
[ -n "$name" ] || usage
entry="$(pin "$name")" || usage
IFS='|' read -r version sha url kind <<<"$entry"

case "$kind" in
  tree:*) path="${TOOLS}/${name}-${version}/${kind#tree:}" ;;
  *) path="${TOOLS}/${name}" ;;
esac
marker="${TOOLS}/.${name}-${version}"
if [ -x "$path" ] && [ -f "$marker" ]; then
  echo "$path"
  exit 0
fi

mkdir -p "$TOOLS"
download="$(mktemp "${TOOLS}/.download.XXXXXX")"
trap 'rm -f "$download"' EXIT
echo "fetching ${name} ${version}" >&2
curl -fsSL "$url" -o "$download"
echo "${sha}  ${download}" | sha256sum -c --quiet - || { echo "${name} ${version} does not match its pinned checksum" >&2; exit 1; }

rm -rf "${TOOLS:?}/${name}" "${TOOLS}/${name}-"* "${TOOLS}/.${name}-"*
case "$kind" in
  binary) install -m 755 "$download" "$path" ;;
  member:*) tar -xzf "$download" -C "$TOOLS" "${kind#member:}"; [ "${kind#member:}" = "$name" ] || mv "${TOOLS}/${kind#member:}" "$path"; chmod 755 "$path" ;;
  zip:*) unzip -p "$download" "${kind#zip:}" > "$path"; chmod 755 "$path" ;;
  tree:*) mkdir -p "${TOOLS}/${name}-${version}"; tar -xzf "$download" -C "${TOOLS}/${name}-${version}" ;;
esac
[ -x "$path" ] || { echo "${name} ${version} has no ${path#"${TOOLS}"/} after unpacking" >&2; exit 1; }
touch "$marker"
echo "$path"
