#!/usr/bin/env bash
set -euo pipefail

REPO="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
TOOLS="${REPO}/.ci-tools"
RUNNER_IMAGE=catthehacker/ubuntu:act-24.04
WORK=""
THROWAWAY=""

cleanup() {
  [ -z "$WORK" ] || rm -rf "$WORK"
  [ -z "$THROWAWAY" ] || git -C "$REPO" tag -d "$THROWAWAY" >/dev/null 2>&1 || true
}
trap cleanup EXIT

usage() {
  cat <<EOF
npm run test:workflows                 actionlint every workflow, then run release.yml on a throwaway tag at HEAD
npm run test:workflows -- <tag>        the same on a tag npm run release made, before you push it
npm run test:workflows -- lint         actionlint only

act runs the jobs in Docker on this machine. It never publishes: under act the release
builds the image without pushing it, packages the chart and prints the notes it would post.
EOF
}

lint() {
  "$(bash "${REPO}/scripts/ci-tools.sh" actionlint)" "${REPO}"/.github/workflows/*.yml
  echo "actionlint: every workflow is valid"
}

act_in_clone() {
  local ref="$1" workflow="$2" event="$3"
  local act
  act="$(bash "${REPO}/scripts/ci-tools.sh" act)"
  mkdir -p "$TOOLS"
  WORK="$(mktemp -d "${TOOLS}/run.XXXXXX")"
  git clone -q --local "$REPO" "${WORK}/repo"
  git -C "${WORK}/repo" checkout -q "$ref"
  git -C "${WORK}/repo" remote set-url origin "$(git -C "$REPO" remote get-url origin)"
  printf '%s\n' "$event" > "${WORK}/event.json"
  (cd "${WORK}/repo" && "$act" push \
    -W "$workflow" \
    -e "${WORK}/event.json" \
    -P "ubuntu-latest=${RUNNER_IMAGE}" \
    --container-architecture linux/amd64 \
    --pull=false)
}

ensure_runner_image() {
  docker image inspect "$RUNNER_IMAGE" >/dev/null 2>&1 && return 0
  echo "pulling ${RUNNER_IMAGE}, the image act runs ubuntu-latest jobs in (about 1.5 GB, once)"
  docker pull -q "$RUNNER_IMAGE" >/dev/null
}

release() {
  local tag="${1:-}"
  if [ -z "$tag" ]; then
    tag="v0000.00.00-act-$(date +%s)"
    THROWAWAY="$tag"
    git -C "$REPO" tag -a "$tag" -m "${tag}" -m "Shipped and released from $(git -C "$REPO" rev-parse --short=12 HEAD) after nothing: a throwaway tag for npm run test:workflows, never pushed"
  fi
  [ "$(git -C "$REPO" cat-file -t "refs/tags/${tag}" 2>/dev/null)" = tag ] || { echo "${tag} is not an annotated tag here" >&2; exit 1; }
  ensure_runner_image
  act_in_clone "refs/tags/${tag}" .github/workflows/release.yml \
    "$(jq -n --arg ref "refs/tags/${tag}" '{ref: $ref}')"
  echo "release.yml ran on ${tag} under act"
}

case "${1:-}" in
  -h|--help) usage ;;
  lint) lint ;;
  *) lint; release "${1:-}" ;;
esac
