export type Named = Readonly<Record<string, string | undefined>>;

const BASE = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'NODE_V8_COVERAGE', 'NODE_OPTIONS',
] as const;

const LOCALE = /^LC_[A-Z]+$/;

export const PERSON_SESSION = ['USER', 'LOGNAME', 'SHELL', 'TERM', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const;

export const DOCKER_CLIENT = ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT'] as const;

const present = (entries: Iterable<[string, string | undefined]>): Record<string, string> =>
  Object.fromEntries([...entries].filter((entry): entry is [string, string] => entry[1] !== undefined));

export function passedOn(names: readonly string[], parent: Named = process.env): Record<string, string> {
  return present(names.map((name) => [name, parent[name]]));
}

export function childEnv(named: Named = {}, parent: Named = process.env): Record<string, string> {
  const base = [...BASE, ...Object.keys(parent).filter((name) => LOCALE.test(name))];
  return present(Object.entries({ ...passedOn(base, parent), ...named }));
}
