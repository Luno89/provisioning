import { Agent, buildConnector, fetch as undiciFetch, type RequestInit as UndiciInit } from 'undici';
import { labFrom, publicAddressProblem, publicFetch } from '../../platform/index.js';
import { instanceOrigin, notReachable, reachOf, reachSettingsFrom, throughOwnCaddy, type ReachedInstance, type ReachSettings, type ThroughCaddy } from '../lib/instance-reach.js';

export interface ReachFetchers {
  open: typeof fetch;
  public: typeof fetch;
  publicProblem: (url: string) => Promise<string | undefined>;
  viaCaddy: (url: URL, init: RequestInit | undefined, to: ThroughCaddy) => Promise<Response>;
}

export function caddyFetch(tls: { ca?: string | Buffer } = {}): ReachFetchers['viaCaddy'] {
  const agents = new Map<string, Agent>();
  return async (url, init, to) => {
    const key = `${to.host}:${to.port}/${to.servername}`;
    let agent = agents.get(key);
    if (!agent) {
      const connect = buildConnector({ ...(tls.ca ? { ca: tls.ca } : {}) });
      agent = new Agent({ connect: (options, callback) => connect({ ...options, hostname: to.host, port: String(to.port), servername: to.servername }, callback) });
      agents.set(key, agent);
    }
    const answered = await undiciFetch(url.href, { ...(init as UndiciInit | undefined), dispatcher: agent });
    return answered as unknown as Response;
  };
}

const DEFAULT_FETCHERS: ReachFetchers = { open: globalThis.fetch, public: publicFetch, publicProblem: publicAddressProblem, viaCaddy: caddyFetch() };

export class InstanceReach {
  constructor(
    private readonly settings: ReachSettings,
    private readonly fetchers: ReachFetchers = DEFAULT_FETCHERS,
  ) {}

  async reportedUrl(raw: unknown, instance: ReachedInstance): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const parsed = instanceOrigin(raw);
    if ('problem' in parsed) return { ok: false, error: parsed.problem };
    const { origin } = parsed;
    if (reachOf(origin, instance, this.settings) !== 'public') return { ok: true, url: origin.origin };
    const problem = await this.fetchers.publicProblem(origin.origin);
    return problem ? { ok: false, error: notReachable(origin.origin, problem) } : { ok: true, url: origin.origin };
  }

  fetchFor(instance: ReachedInstance): typeof fetch {
    return async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const caddy = throughOwnCaddy(url, this.settings);
      if (caddy) return this.fetchers.viaCaddy(url, { ...init, redirect: 'manual' }, caddy);
      const reach = reachOf(url, instance, this.settings);
      if (reach === 'public') return this.fetchers.public(url, init);
      return this.fetchers.open(url, { ...init, redirect: 'manual' });
    };
  }
}

export const instanceReachFrom = (env: Readonly<Record<string, string | undefined>>): InstanceReach =>
  new InstanceReach(reachSettingsFrom(env, labFrom(env)));
