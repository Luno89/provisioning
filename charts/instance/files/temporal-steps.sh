#!/bin/sh
set -eu

AT=/steps/at
TEMPORAL_DB=${DBNAME:-temporal}
VISIBILITY_DB=${VISIBILITY_DBNAME:-temporal_visibility}

behind() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

newest_in() {
  ls "/etc/temporal/schema/postgresql/v12/$1/versioned" | sed 's/^v//' | sort -V | tail -n 1
}

plan() {
  export PGPASSWORD="$POSTGRES_PWD"
  ask() { psql -h "$POSTGRES_SEEDS" -p "${DB_PORT:-5432}" -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -tAc "$2"; }
  until pg_isready -q -h "$POSTGRES_SEEDS" -p "${DB_PORT:-5432}" -U "$POSTGRES_USER"; do
    echo "waiting for Temporal's database at $POSTGRES_SEEDS"
    sleep 2
  done
  schema_of() {
    if [ -z "$(ask postgres "SELECT 1 FROM pg_database WHERE datname = '$1'")" ]; then return 0; fi
    if [ -z "$(ask "$1" "SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_version'")" ]; then return 0; fi
    ask "$1" "SELECT curr_version FROM schema_version WHERE version_partition = 0 AND db_name = '$1'"
  }
  main=$(schema_of "$TEMPORAL_DB")
  visibility=$(schema_of "$VISIBILITY_DB")
  if [ -z "$main" ] || [ -z "$visibility" ]; then
    echo fresh > "$AT"
    chmod a+w "$AT"
    echo "Temporal's database holds no schema yet; Temporal sets it up at its own version"
    return 0
  fi
  if behind "$NEWEST_MAIN" "$main" || behind "$NEWEST_VISIBILITY" "$visibility"; then
    echo "Temporal's database is at schema $main (visibility $visibility), past what this Temporal knows ($NEWEST_MAIN, visibility $NEWEST_VISIBILITY): a newer Temporal ran on it, and this one cannot" >&2
    exit 1
  fi
  echo "$main $visibility" > "$AT"
  chmod a+w "$AT"
  echo "Temporal's database is at schema $main (visibility $visibility)"
}

step() {
  read -r at < "$AT"
  mine_main=$(newest_in temporal)
  mine_visibility=$(newest_in visibility)
  if [ "$at" = fresh ]; then
    echo "a new database goes straight to the Temporal that runs it; nothing to step through for schema $mine_main"
    return 0
  fi
  set -- $at
  if ! behind "$1" "$mine_main" && ! behind "$2" "$mine_visibility"; then
    echo "Temporal's database is already at schema $1 (visibility $2), not behind $mine_main (visibility $mine_visibility)"
    return 0
  fi
  echo "stepping Temporal's database from schema $1 (visibility $2) to $mine_main (visibility $mine_visibility)"
  /etc/temporal/entrypoint.sh autosetup &
  server=$!
  until temporal operator cluster health --address 127.0.0.1:7233 2>/dev/null | grep -q SERVING; do
    if ! kill -0 "$server" 2>/dev/null; then
      echo "Temporal stopped before it answered at schema $mine_main" >&2
      exit 1
    fi
    sleep 2
  done
  kill "$server"
  wait "$server" || true
  echo "$mine_main $mine_visibility" > "$AT"
  echo "Temporal's database is at schema $mine_main (visibility $mine_visibility)"
}

case "${1:-}" in
  plan) plan ;;
  step) step ;;
  *) echo "usage: temporal-steps.sh plan|step" >&2; exit 2 ;;
esac
