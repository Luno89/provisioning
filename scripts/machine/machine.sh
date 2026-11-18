#!/bin/sh
set -eu

KOALA_URL="__KOALA_URL__"
NODE_VERSION=22.23.4
NODE_SHA256_LINUX_X64=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
NODE_SHA256_LINUX_ARM64=f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9
NODE_SHA256_DARWIN_ARM64=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428
NODE_SHA256_DARWIN_X64=efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819

url_next=0
for arg in "$@"; do
  if [ "$url_next" = 1 ]; then KOALA_URL="$arg"; url_next=0; fi
  [ "$arg" = --url ] && url_next=1
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

have curl || die "curl is needed"
have tar || die "tar is needed"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) platform=linux-x64; sha="$NODE_SHA256_LINUX_X64" ;;
  Linux-aarch64|Linux-arm64) platform=linux-arm64; sha="$NODE_SHA256_LINUX_ARM64" ;;
  Darwin-arm64) platform=darwin-arm64; sha="$NODE_SHA256_DARWIN_ARM64" ;;
  Darwin-x86_64) platform=darwin-x64; sha="$NODE_SHA256_DARWIN_X64" ;;
  *) die "this machine is $(uname -s) $(uname -m), which Koala's machine agent does not run on yet" ;;
esac

say "Getting the machine agent"
SHARE="${XDG_DATA_HOME:-$HOME/.local/share}/koala"
NODE_DIR="$SHARE/node-v${NODE_VERSION}"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  work="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${platform}.tar.gz" -o "$work/node.tar.gz" || { rm -rf "$work"; die "could not download Node.js"; }
  [ "$(sha256_of "$work/node.tar.gz")" = "$sha" ] || { rm -rf "$work"; die "the Node.js download is not the one Koala pins (its sha256 differs); nothing was installed"; }
  tar -xzf "$work/node.tar.gz" -C "$work"
  mkdir -p "$SHARE"
  rm -rf "$NODE_DIR"
  mv "$work/node-v${NODE_VERSION}-${platform}" "$NODE_DIR"
  rm -rf "$work"
fi
PATH="$NODE_DIR/bin:$PATH"
export PATH
ok "Node.js $("$NODE_DIR/bin/node" -v) of Koala's own, in $NODE_DIR; your own Node.js is left as it is"

AGENT_DIR="$SHARE/machine"
AGENT_SHA256=$(curl -fsSL "${KOALA_URL}/api/machines/agent.tgz.sha256" | cut -d' ' -f1)
[ -n "$AGENT_SHA256" ] || die "${KOALA_URL} did not say which machine agent it serves; nothing was installed"
if [ "$(cat "$AGENT_DIR/bundle.sha256" 2>/dev/null)" != "$AGENT_SHA256" ]; then
  next="$AGENT_DIR.next"
  bundle="$(mktemp)"
  curl -fsSL "${KOALA_URL}/api/machines/agent.tgz" -o "$bundle" || { rm -f "$bundle"; die "could not download the machine agent"; }
  [ "$(sha256_of "$bundle")" = "$AGENT_SHA256" ] || { rm -f "$bundle"; die "the machine agent Koala sent is not the one it built (its sha256 differs); nothing was installed"; }
  rm -rf "$next"
  mkdir -p "$next"
  tar -xzf "$bundle" -C "$next"
  rm -f "$bundle"
  (cd "$next" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null) || die "the machine agent's packages could not be installed"
  printf '%s\n' "$AGENT_SHA256" > "$next/bundle.sha256"
  rm -rf "$AGENT_DIR"
  mv "$next" "$AGENT_DIR"
fi
ok "the machine agent ${AGENT_SHA256%"${AGENT_SHA256#????????????}"}, in $AGENT_DIR"

exec "$NODE_DIR/bin/node" "$AGENT_DIR/agent.mjs" join --url "$KOALA_URL" "$@"
