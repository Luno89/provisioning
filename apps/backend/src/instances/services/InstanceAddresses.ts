import fs from 'fs/promises';
import type { InstanceAddresses as Addresses } from '../lib/instances.js';
import { rootAnswer } from '../lib/root-answer.js';
import type { InstanceEdge } from '../../infrastructure/index.js';

export interface InstanceAddressesSettings {
  rootUrl: string;
  instanceId: string;
  token: () => Promise<string>;
  name: string;
}

export type AddressesView = Addresses & { name: string; domain: string };

export class InstanceAddresses {
  private current: AddressesView | undefined;
  private watching: NodeJS.Timeout | undefined;

  constructor(
    private readonly settings: InstanceAddressesSettings,
    private readonly republish: () => Promise<void>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly everyMs = 15_000,
  ) {}

  nestedReady(): boolean {
    return Boolean(this.current?.nested && this.current.state === 'ready');
  }

  private async call(method: 'GET' | 'PUT', body?: unknown): Promise<AddressesView> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/addresses`, {
      method,
      headers: { 'content-type': 'application/json', 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${await this.settings.token()}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = rootAnswer(response.ok, response.status, await response.text());
    if (!response.ok) throw new Error(`root did not answer about this instance's addresses (${response.status}): ${answer.error ?? 'no reason given'}`);
    return answer.body as AddressesView;
  }

  private async take(next: AddressesView): Promise<AddressesView> {
    const wasReady = this.nestedReady();
    this.current = next;
    if (this.nestedReady() !== wasReady) await this.republish();
    if (next.nested && next.state === 'issuing') this.watch();
    return next;
  }

  private watch(): void {
    if (this.watching) return;
    this.watching = setInterval(() => {
      void this.refresh().then((view) => {
        if (!(view.nested && view.state === 'issuing')) this.unwatch();
      }).catch((err: Error) => console.warn(`[addresses] how this instance's nested addresses are being issued could not be read from root; asking again in ${Math.round(this.everyMs / 1000)}s: ${err.message}`));
    }, this.everyMs);
  }

  private unwatch(): void {
    if (this.watching) clearInterval(this.watching);
    this.watching = undefined;
  }

  async refresh(): Promise<AddressesView> {
    return this.take(await this.call('GET'));
  }

  async set(nested: boolean): Promise<AddressesView> {
    return this.take(await this.call('PUT', { nested }));
  }

  stop(): void {
    this.unwatch();
  }
}

export function adminEdge(name: string, adminUrl: string, caddyfile: string, addresses: () => InstanceAddresses | undefined, fetchImpl: typeof fetch = globalThis.fetch): InstanceEdge {
  return {
    name,
    nestedReady: () => addresses()?.nestedReady() ?? false,
    async reload() {
      const response = await fetchImpl(`${adminUrl}/load`, { method: 'POST', headers: { 'content-type': 'text/caddyfile' }, body: await fs.readFile(caddyfile, 'utf8') });
      if (!response.ok) throw new Error(`the edge refused its config (${response.status}): ${(await response.text()).slice(0, 500)}`);
    },
  };
}
