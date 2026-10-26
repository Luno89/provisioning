export interface ArrivingRequest {
  host?: string | undefined;
  origin?: string | undefined;
  fetchSite?: string | undefined;
}

export interface OurOrigins {
  hosts: ReadonlySet<string>;
  loopback: boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK = /^(localhost|.+\.localhost|127\.0\.0\.1|\[::1\])$/;

const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try { return new URL(url).host.toLowerCase(); } catch { return undefined; }
};

export function ourOrigins(env: Readonly<Record<string, string | undefined>>): OurOrigins {
  const hosts = [env.PUBLIC_URL, env.APP_URL].map(hostOf).filter((host): host is string => Boolean(host));
  return { hosts: new Set(hosts), loopback: env.NODE_ENV !== 'production' };
}

export function foreignOrigin(request: ArrivingRequest, ours: OurOrigins): string | undefined {
  const origin = request.origin?.trim();
  if (origin) {
    if (origin === 'null') return 'this request came from a page with no origin of its own';
    const from = hostOf(origin);
    if (!from) return `this request came from ${origin}, which is not an address`;
    if (from === request.host?.toLowerCase() || ours.hosts.has(from)) return undefined;
    if (ours.loopback && LOOPBACK.test(new URL(origin).hostname)) return undefined;
    return `this request came from ${origin}, which is not this site`;
  }
  const site = request.fetchSite?.trim().toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return `this request came from another site (${site})`;
  return undefined;
}

export function crossSiteRefusal(method: string, request: ArrivingRequest, ours: OurOrigins): string | undefined {
  return SAFE_METHODS.has(method.toUpperCase()) ? undefined : foreignOrigin(request, ours);
}
