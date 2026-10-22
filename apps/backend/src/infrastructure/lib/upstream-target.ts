const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

export function isUpstreamTarget(target: string): boolean {
  const match = /^(.+):(\d{1,5})$/.exec(target);
  if (!match) return false;
  const [, host, port] = match;
  const portNumber = Number(port);
  if (portNumber < 1 || portNumber > 65535) return false;
  if (/^[\d.]+$/.test(host!)) return IPV4.test(host!);
  return HOSTNAME.test(host!);
}

export function assertUpstreamTarget(target: string, app: string): string {
  if (!isUpstreamTarget(target)) {
    throw new Error(`Refusing to expose "${app}": "${target}" is not a host:port the proxy can reach.`);
  }
  return target;
}
