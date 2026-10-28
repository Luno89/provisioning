#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/backend"
npx tsx src/scripts/temporal-keys.ts "$ROOT/apps/backend/data/temporal-keys/temporal-jwks.json"

TLS="$ROOT/apps/backend/data/temporal-tls"
if [ ! -s "$TLS/server.crt" ] || [ ! -s "$TLS/ca.crt" ]; then
  mkdir -p "$TLS"
  chmod 755 "$TLS"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/ca.key"
  openssl req -x509 -new -key "$WORK/ca.key" -sha256 -days 3650 -subj "/CN=Koala Temporal CA" -out "$TLS/ca.crt"
  openssl ecparam -name prime256v1 -genkey -noout -out "$TLS/server.key"
  openssl req -new -key "$TLS/server.key" -subj "/CN=temporal" -out "$WORK/server.csr"
  printf 'subjectAltName=DNS:localhost,DNS:temporal,DNS:host.k3d.internal,DNS:host.docker.internal,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n' > "$WORK/ext"
  openssl x509 -req -in "$WORK/server.csr" -CA "$TLS/ca.crt" -CAkey "$WORK/ca.key" -CAcreateserial -CAserial "$WORK/ca.srl" -days 3650 -sha256 -extfile "$WORK/ext" -out "$TLS/server.crt" 2>/dev/null
  chmod 644 "$TLS/ca.crt" "$TLS/server.crt"
  chmod 600 "$TLS/server.key"
  echo "[temporal-tls] made Temporal's certificate, signed by a CA of its own, in $TLS"
fi
if [ "$(id -u)" -eq 0 ]; then chown -R 1000:1000 "$TLS"; fi
