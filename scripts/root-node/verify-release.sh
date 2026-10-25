#!/usr/bin/env bash
set -euo pipefail

SIGNERS="${RELEASE_SIGNERS:-/etc/koala/release-signers}"
COSIGN="${COSIGN:-cosign}"
PUBLISHED_IMAGE="${PUBLISHED_IMAGE:-ghcr.io/luno89/nowrinkles/app}"
RELEASE_REPO="${RELEASE_REPO:-Luno89/provisioning}"
ISSUER=https://token.actions.githubusercontent.com

usage() {
  cat <<EOF >&2
verify-release.sh tag <repo dir> <tag>       the tag is signed by a key in ${SIGNERS}; prints the commit it names
verify-release.sh image <tag> <commit>       the image the Release workflow published for that commit was built by
                                             release.yml at that tag; pulls it and prints it by digest
EOF
  exit 2
}

tag() {
  local repo="$1" name="$2"
  [ -s "$SIGNERS" ] || { echo "no release signers at ${SIGNERS}, so no tag can be trusted" >&2; exit 1; }
  [ "$(git -C "$repo" cat-file -t "refs/tags/${name}" 2>/dev/null)" = tag ] || { echo "${name} is not an annotated tag" >&2; exit 1; }
  local said
  said="$(git -C "$repo" -c gpg.ssh.allowedSignersFile="$SIGNERS" verify-tag "$name" 2>&1)" \
    || { echo "${name} is not signed by a key in ${SIGNERS}: $(printf '%s' "$said" | tail -1)" >&2; exit 1; }
  git -C "$repo" rev-parse "refs/tags/${name}^{commit}"
}

image() {
  local name="$1" commit="$2" pulled digest said
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "give the tag's whole commit, not ${commit}" >&2; exit 1; }
  pulled="${PUBLISHED_IMAGE}:${commit:0:12}"
  docker pull -q "$pulled" >/dev/null || { echo "${pulled} is not published" >&2; exit 1; }
  digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$pulled" | grep -m1 "^${PUBLISHED_IMAGE}@sha256:" || true)"
  [ -n "$digest" ] || { echo "${pulled} has no digest from ${PUBLISHED_IMAGE}" >&2; exit 1; }
  said="$("$COSIGN" verify-attestation --type slsaprovenance1 \
    --certificate-oidc-issuer "$ISSUER" \
    --certificate-identity "https://github.com/${RELEASE_REPO}/.github/workflows/release.yml@refs/tags/${name}" \
    --certificate-github-workflow-sha "$commit" \
    "$digest" 2>&1)" \
    || { echo "${digest} carries no attestation that release.yml built it from ${commit:0:12} at ${name}: $(printf '%s' "$said" | tail -1)" >&2; exit 1; }
  echo "$digest"
}

case "${1:-}" in
  tag) [ $# -eq 3 ] || usage; tag "$2" "$3" ;;
  image) [ $# -eq 3 ] || usage; image "$2" "$3" ;;
  *) usage ;;
esac
