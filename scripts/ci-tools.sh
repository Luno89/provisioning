#!/usr/bin/env bash
set -euo pipefail

REPO="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
TOOLS="${CI_TOOLS:-${REPO}/.ci-tools}"
GH=https://github.com

pin() {
  case "$1" in
    act)        echo "0.2.89|0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0|${GH}/nektos/act/releases/download/v0.2.89/act_Linux_x86_64.tar.gz|member:act" ;;
    actionlint) echo "1.7.12|8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8|${GH}/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz|member:actionlint" ;;
    gitleaks)   echo "8.30.1|551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb|${GH}/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz|member:gitleaks" ;;
    trufflehog) echo "3.99.2|3c7b0d1dc4278294269bfdd7594bca8bb28c78da0a4a06ad202ded37b48deca4|${GH}/trufflesecurity/trufflehog/releases/download/v3.99.2/trufflehog_3.99.2_linux_amd64.tar.gz|member:trufflehog" ;;
    opengrep)   echo "1.30.2|a66aa3278457f02b287b985a45b6762aebcaba5000f2689245fd1ed86d1456c7|${GH}/opengrep/opengrep/releases/download/v1.30.2/opengrep_manylinux_x86|binary" ;;
    osv-scanner) echo "2.6.0|ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108|${GH}/google/osv-scanner/releases/download/v2.6.0/osv-scanner_linux_amd64|binary" ;;
    trivy)      echo "0.75.0|c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f|${GH}/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz|member:trivy" ;;
    zizmor)     echo "1.30.1|e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a|${GH}/zizmorcore/zizmor/releases/download/v1.30.1/zizmor-x86_64-unknown-linux-gnu.tar.gz|member:zizmor" ;;
    kubescape)  echo "4.0.15|6c9fd51bcdcd1093d19383ef20e1c58c2bf83c9026073f8dcc786680ed2a0093|${GH}/kubescape/kubescape/releases/download/v4.0.15/kubescape_4.0.15_linux_amd64.tar.gz|member:kubescape" ;;
    nuclei)     echo "3.11.1|ea63d4ae232808cd7c6bc00d0142428e231fab59dae01042246097d195835ab6|${GH}/projectdiscovery/nuclei/releases/download/v3.11.1/nuclei_3.11.1_linux_amd64.zip|zip:nuclei" ;;
    lynis)      echo "3.1.7|b5314a07fd85fa3ffc7da57b508f0108ec3280d84e4af823f805d95cbbc2428c|https://downloads.cisofy.com/lynis/lynis-3.1.7.tar.gz|tree:lynis/lynis" ;;
    cosign)     echo "3.1.3|4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71|${GH}/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64|binary" ;;
    codeql)     echo "2.27.2|f002864be6dd8d5d7bdb123aaf7291ec8e291012bd9f70b6d2362f730db52aeb|${GH}/github/codeql-action/releases/download/codeql-bundle-v2.27.2/codeql-bundle-linux64.tar.gz|tree:codeql/codeql" ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<EOF >&2
bash scripts/ci-tools.sh <tool>   fetches the pinned tool into .ci-tools/ when it is missing, checks its sha256, and prints its path
tools: act actionlint gitleaks trufflehog opengrep osv-scanner trivy zizmor kubescape nuclei lynis cosign codeql
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
