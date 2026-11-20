#!/bin/sh
set -eu

: "${POSTGRES_SEEDS:?the address of Temporal's database}"
: "${POSTGRES_USER:?the user Temporal's database is reached as}"
: "${POSTGRES_PWD:?that user's password}"
: "${DB_PORT:=5432}"
: "${DBNAME:=temporal}"
: "${VISIBILITY_DBNAME:=temporal_visibility}"

export SQL_PASSWORD="$POSTGRES_PWD"
schema=/etc/temporal/schema/postgresql/v12

sql() {
  db="$1"
  shift
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "$DB_PORT" --db "$db" "$@"
}

ready() {
  name="$1"
  dir="$2"
  newest=$(ls "$schema/$dir/versioned" | sed 's/^v//' | sort -V | tail -n 1)
  if [ "$name" != "$POSTGRES_USER" ]; then sql "$name" create; fi
  sql "$name" setup-schema -v 0.0
  said=$(sql "$name" update-schema -d "$schema/$dir/versioned" 2>&1) || { printf '%s\n' "$said" >&2; exit 1; }
  printf '%s\n' "$said"
  current=$(printf '%s\n' "$said" | sed -n 's/.*from current version \([0-9.]*\).*/\1/p' | tail -n 1)
  if [ -n "$current" ] && [ "$(printf '%s\n%s\n' "$current" "$newest" | sort -V | tail -n 1)" != "$newest" ]; then
    echo "Temporal's database $name is at schema $current, past what this Temporal knows ($newest): a newer Temporal ran on it, and this one cannot" >&2
    exit 1
  fi
}

ready "$DBNAME" temporal
ready "$VISIBILITY_DBNAME" visibility
echo "Temporal's database and its visibility database are at the schema this Temporal runs"
