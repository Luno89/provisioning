import { labFrom, publicAddressProblem, publicFetch } from '../../platform/index.js';
import { instanceOrigin, notReachable, reachOf, reachSettingsFrom, type ReachedInstance, type ReachSettings } from '../lib/instance-reach.js';

export interface ReachFetchers {
  open: typeof fetch;
  public: typeof fetch;
  publicProblem: (url: string) => Promise<string | undefined>;
}

const DEFAULT_FETCHERS: ReachFetchers = { open: globalThis.fetch, public: publicFetch, publicProblem: publicAddressProblem };

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
      const reach = reachOf(url, instance, this.settings);
      if (reach === 'public') return this.fetchers.public(url, init);
      return this.fetchers.open(url, { ...init, redirect: 'manual' });
    };
  }
}

export const instanceReachFrom = (env: Readonly<Record<string, string | undefined>>): InstanceReach =>
  new InstanceReach(reachSettingsFrom(env, labFrom(env)));
