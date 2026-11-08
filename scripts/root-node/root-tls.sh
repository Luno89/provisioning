#!/usr/bin/env bash
set -euo pipefail

file="${1:?usage: root-tls.sh <root env file>}"
[ -f "$file" ] || exit 0
grep -qE '^ROOT_TLS=' "$file" || exit 0

value() { grep -E "^$1=" "$file" | tail -n1 | cut -d= -f2- || true; }
held() { grep -qE "^$1=" "$file"; }

legacy="$(value ROOT_TLS)"
case "$legacy" in
  internal) wanted=(CERTIFICATES=internal) ;;
  cloudflare) wanted=(CERTIFICATES=acme DOMAIN_DNS=cloudflare INGRESS_DNS=cloudflare) ;;
  "") wanted=() ;;
  *)
    echo "ROOT_TLS in ${file} is ${legacy}, which no release of Koala read (it was internal or cloudflare). Set CERTIFICATES=acme or internal, and DOMAIN_DNS and INGRESS_DNS to each zone's DNS provider, then remove ROOT_TLS. Nothing was changed." >&2
    exit 1
    ;;
esac

[ -n "$(tail -c1 "$file")" ] && echo >> "$file"
added=()
for setting in "${wanted[@]}"; do
  name="${setting%%=*}"
  held "$name" && continue
  echo "$setting" >> "$file"
  added+=("$setting")
done
sed -i '/^ROOT_TLS=/d' "$file"
if [ "${#added[@]}" -gt 0 ]; then
  echo "ROOT_TLS=${legacy} in ${file} is now ${added[*]}"
else
  echo "ROOT_TLS=${legacy} in ${file} is gone; the settings beside it already said the same or more"
fi
