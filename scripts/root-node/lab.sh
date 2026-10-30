#!/usr/bin/env bash
set -euo pipefail

certificates="${1:-}"
root_tls="${2:-}"
domain="${3:-}"

lab_domain() {
  case "$1" in
    internal|*.internal|localhost|*.localhost) return 0 ;;
    *) return 1 ;;
  esac
}

claimed=""
[ "$certificates" = internal ] && claimed="CERTIFICATES=internal"
[ "$root_tls" = internal ] && claimed="${claimed:+${claimed} and }ROOT_TLS=internal"
if [ -n "$claimed" ] && ! lab_domain "$domain"; then
  echo "This root's settings say ${claimed}, a lab, but DOMAIN is ${domain:-not set}, a real domain. A lab runs only under a name nothing public resolves (koala.internal for the rehearsal), since it takes any git ref and images nobody checked. On a real root set CERTIFICATES=acme and remove ROOT_TLS=internal from .env, then run this again. Nothing was changed." >&2
  exit 1
fi
if [ "$certificates" = internal ] || { [ -z "$certificates" ] && [ "$root_tls" = internal ]; }; then
  echo 1
else
  echo 0
fi
