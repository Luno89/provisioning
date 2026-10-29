import { resolveNs } from 'node:dns/promises';
import { planIsDone, zonePlan, type PlanStep, type WantedRecord } from '../../lib/dns-plan.js';
import {
  describeProvider, DnsProviderRefusal, DNS_PROVIDERS, providerForNameservers,
  type DnsCredentials, type DnsProvider, type DnsValidation, type DnsZone,
} from '../../lib/dns-providers.js';
import type { FetchLike } from '../OvhClient.js';
import { cloudflareProvider } from './cloudflare.js';
import { porkbunProvider } from './porkbun.js';

export const DNS_PROVIDER_CLIENTS: readonly ((fetchImpl: FetchLike) => DnsProvider)[] = [cloudflareProvider, porkbunProvider];

export interface ZoneDetection {
  zone: string;
  nameservers: string[];
  provider?: string | undefined;
  problem?: string | undefined;
}

export class DnsProviders {
  private readonly byName: ReadonlyMap<string, DnsProvider>;

  constructor(
    fetchImpl: FetchLike = fetch,
    private readonly nameserversOf: (zone: string) => Promise<string[]> = (zone) => resolveNs(zone),
  ) {
    const providers = DNS_PROVIDER_CLIENTS.map((make) => make(fetchImpl));
    this.byName = new Map(providers.map((provider) => [provider.name, provider]));
    const described = DNS_PROVIDERS.map((provider) => provider.name).sort().join(',');
    const built = [...this.byName.keys()].sort().join(',');
    if (described !== built) throw new Error(`the DNS providers described (${described}) are not the ones with a client (${built})`);
  }

  describe() {
    return DNS_PROVIDERS.map(describeProvider);
  }

  provider(name: string): DnsProvider {
    const found = this.byName.get(name);
    if (!found) throw new DnsProviderRefusal(`${name} is not a DNS provider Koala knows (it knows ${[...this.byName.keys()].join(', ')})`);
    return found;
  }

  validate(name: string, credentials: DnsCredentials): Promise<DnsValidation> {
    return this.provider(name).validate(credentials);
  }

  zone(name: string, credentials: DnsCredentials, zone: string): Promise<DnsZone> {
    return this.provider(name).zone(credentials, zone);
  }

  async detect(zone: string): Promise<ZoneDetection> {
    let nameservers: string[];
    try {
      nameservers = await this.nameserversOf(zone);
    } catch (error) {
      return { zone, nameservers: [], problem: `${zone} has no nameservers Koala can find (${(error as { code?: string }).code ?? (error as Error).message}); check the domain is registered and its nameservers are set` };
    }
    const found = providerForNameservers(nameservers);
    return 'provider' in found ? { zone, nameservers, provider: found.provider } : { zone, nameservers, problem: `${zone}: ${found.problem}` };
  }

  async plan(zone: DnsZone, wanted: readonly WantedRecord[]): Promise<PlanStep[]> {
    const existing = (await Promise.all(wanted.map((want) => zone.list(want.type, want.name)))).flat();
    return zonePlan(wanted, existing);
  }

  async apply(zone: DnsZone, steps: readonly PlanStep[]): Promise<{ done: boolean; lines: string[] }> {
    const lines: string[] = [];
    for (const step of steps) {
      if (step.do === 'create') {
        await zone.create(step.record);
        lines.push(`added ${step.record.type} ${step.record.name}: ${step.why}`);
      } else if (step.do === 'update') {
        await zone.update(step.record);
        lines.push(`updated ${step.record.type} ${step.record.name}: ${step.why}`);
      } else if (step.do === 'keep') {
        lines.push(step.why);
      } else {
        lines.push(`left as it is: ${step.why}`);
      }
    }
    return { done: planIsDone(steps), lines };
  }
}
