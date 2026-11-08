#!/usr/bin/env bash
set -euo pipefail

certificates="${1:-}"
domain="${2:-}"

lab_domain() {
  case "$1" in
    internal|*.internal|localhost|*.localhost) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$certificates" = internal ] && ! lab_domain "$domain"; then
  echo "This root's settings say CERTIFICATES=internal, a lab, but DOMAIN is ${domain:-not set}, a real domain. A lab runs only under a name nothing public resolves (koala.internal for the rehearsal), since it takes any git ref and images nobody checked. On a real root set CERTIFICATES=acme in .env, then run this again. Nothing was changed." >&2
  exit 1
fi
if [ "$certificates" = internal ]; then
  echo 1
else
  echo 0
fi
