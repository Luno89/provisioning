export type Settings = Readonly<Record<string, string | undefined>>;

export function missingSettings(env: Settings, names: readonly string[]): string[] {
  return names.filter((name) => !env[name]?.trim());
}

export function notSetProblem(what: string, missing: readonly string[], setBy: string): string {
  return `${what}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set; ${setBy}`;
}

export function settingUrl(name: string, raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not an address: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} is not an http or https address: ${value}`);
  if (url.username || url.password) throw new Error(`${name} names a sign-in, which is never kept in an address: ${url.protocol}//…@${url.host}`);
  if (url.search || url.hash) throw new Error(`${name} carries a query or a fragment, which nothing appends to: ${value}`);
  if (url.pathname.replace(/\/+$/, '') !== '') throw new Error(`${name} has a path, and is the service's own address: ${value}`);
  return `${url.protocol}//${url.host}`;
}

export function settingHostPort(name: string, raw: string): string {
  const value = raw.trim();
  const at = value.lastIndexOf(':');
  const host = at > 0 ? value.slice(0, at) : '';
  const portText = value.slice(at + 1);
  const port = Number(portText);
  if (!host || /[\s/@]/.test(host) || !/^\d+$/.test(portText) || !(port > 0 && port < 65536)) throw new Error(`${name} is not a host and port: ${value}`);
  return value;
}
