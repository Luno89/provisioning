#!/usr/bin/env bash

ensure_root_setting() {
  local file="$1" name="$2" value="$3"
  grep -q "^${name}=" "$file" && return 0
  echo "${name}=${value}" >> "$file"
  echo "  ✓ ${name} set"
}

ensure_root_settings() {
  local file="$1" repo="$2" compose="$3" public relay
  public="$(grep -E '^PUBLIC_URL=' "$file" | cut -d= -f2- || true)"
  [ -n "$public" ] || { echo "  ✗ PUBLIC_URL is not set in ${file}, so root's other addresses cannot be set from it" >&2; return 1; }
  ensure_root_setting "$file" PORT 3001
  ensure_root_setting "$file" APP_URL "$public"
  ensure_root_setting "$file" TRUST_PROXY 1
  ensure_root_setting "$file" TEMPORAL_CONNECTION_ADDRESS 127.0.0.1:7233
  ensure_root_setting "$file" TEMPORAL_NAMESPACE default
  ensure_root_setting "$file" TEMPORAL_TLS_CA "${repo}/apps/backend/data/temporal-tls/ca.crt"
  ensure_root_setting "$file" DATA_DIR "${repo}/apps/backend/data"
  ensure_root_setting "$file" TERRAFORM_STATE local
  ensure_root_setting "$file" HEADSCALE_URL http://127.0.0.1:8080
  ensure_root_setting "$file" HEALTH_PORT 0
  ensure_root_setting "$file" TEMPORAL_METRICS_PORT 9465
  ensure_root_setting "$file" INSTANCE_IMAGE_TAG "$(git -C "$repo" rev-parse --short=12 HEAD)"
  ensure_root_setting "$file" POOL_SLOT_CPU 4
  ensure_root_setting "$file" POOL_SLOT_STORAGE_GIB 100
  ensure_root_setting "$file" POOL_TRIAL_DAYS 14
  relay="$(grep -E '^MAIL_RELAYHOST=' "$compose" 2>/dev/null | cut -d= -f2- || true)"
  [ -n "$relay" ] && ensure_root_setting "$file" MAIL_RELAYHOST "$relay"
  return 0
}
