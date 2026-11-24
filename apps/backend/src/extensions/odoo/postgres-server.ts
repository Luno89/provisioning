export const PG_ROOT = '/usr/lib/postgresql';

export const PG_SERVER_BIN = [
  `pgbin=$(for dir in $(ls -d ${PG_ROOT}/*/bin 2>/dev/null | sort -V -r); do if [ -x "$dir/initdb" ]; then echo "$dir"; break; fi; done)`,
  `[ -n "$pgbin" ] || { echo "no PostgreSQL server is installed here: no initdb under ${PG_ROOT}" >&2; exit 1; }`,
].join('\n');
