#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/nowrinkles}"
[ "$(id -u)" -eq 0 ] || { echo "Run as root: update.sh restarts a systemd unit." >&2; exit 1; }
[ -d "$REPO_DIR/.git" ] || { echo "No repo at ${REPO_DIR}. Run bootstrap.sh first." >&2; exit 1; }

current="$(git -C "$REPO_DIR" describe --exact-match --tags --match 'v*' HEAD 2>/dev/null || true)"
wanted="${1:-}"
if [ -z "$wanted" ]; then
  origin="$(git -C "$REPO_DIR" remote get-url origin)"
  slug="$(printf '%s' "$origin" | sed -nE 's#^(https://github\.com/|git@github\.com:)([^/]+/[^/]+)$#\2#p' | sed -E 's#\.git$##')"
  [ -n "$slug" ] || { echo "root's checkout does not come from GitHub (${origin}), so there are no published releases to follow" >&2; exit 1; }
  wanted="$(curl -fsS -m 30 "https://api.github.com/repos/${slug}/releases/latest" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tag_name ?? "")}catch{console.log("")}})' || true)"
  [ -n "$wanted" ] || { echo "found no published release of ${slug} on GitHub; looking again next time"; exit 0; }
  if [ "$wanted" = "$current" ]; then echo "root runs ${current}, the newest release"; exit 0; fi
  if [ -n "$current" ] && [ "$(printf '%s\n%s\n' "$current" "$wanted" | sort -V | tail -1)" = "$current" ]; then
    echo "root runs ${current}, newer than the newest published release ${wanted}; leaving it"
    exit 0
  fi
fi
[[ "$wanted" =~ ^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(-[0-9]+)?$ ]] || { echo "${wanted} is not a release tag" >&2; exit 1; }

echo "moving root from ${current:-$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)} to ${wanted}"
copy="$(mktemp -d)"
trap 'rm -rf "$copy"' EXIT
cp "$REPO_DIR/scripts/root-node/update.sh" "$REPO_DIR/scripts/root-node/cdktf-bindings.sh" "$REPO_DIR/scripts/root-node/verify-release.sh" "$copy/"
bash "$copy/update.sh" "$wanted"
