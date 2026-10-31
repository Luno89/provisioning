import { randomUUID } from 'node:crypto';
import { decryptValue, encryptValue, mailCheckFrom, mailHostOf, mailReport, type SecretKey } from '../../platform/index.js';
import type { InfrastructureStore } from '../store.js';
import {
  configurationFor, FOLLOWING, mandatoryOptions, newestRelease, orderStateOf, priceChangeProblem, quoteFromCheckout, ROOT_OS,
  rootDnsRecords, rootDomainProblem, STATE_SAID, type ServerOrder, type ServerOrderState, type ServerQuote,
} from '../lib/server-orders.js';
import { credentialEnvOf, dnsProviderNamed, DnsProviderRefusal, type DnsCredentials, type DnsZone } from '../lib/dns-providers.js';
import { DnsProviders } from './dns/DnsProviders.js';
import { OvhClient, OvhError, type FetchLike, type OvhAccount } from './OvhClient.js';
import { forwardNotSeen, ipBlockFor, ptrValue, reverseDnsPath, reverseDnsSaid, samePtr, type ReverseDnsState } from '../lib/reverse-dns.js';

export class ServerOrderProblem extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ServerOrderDeps {
  store: Pick<InfrastructureStore, 'getServerOrders' | 'getServerOrder' | 'saveServerOrder' | 'patchServerOrder' | 'appendServerOrderLog'>;
  dataKey: SecretKey;
  ovhAccountOf: (ownerId: string) => Promise<OvhAccount | undefined>;
  dnsCredentialsOf: (ownerId: string, provider: string) => Promise<DnsCredentials | undefined>;
  dns?: DnsProviders;
  startFollowing?: (order: ServerOrder) => Promise<string>;
  stopFollowing?: (workflowId: string) => Promise<void>;
  lsRemote?: () => Promise<string>;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export interface QuoteAsk {
  planCode: string;
  planLabel: string;
  datacenter: string;
  domain: string;
  ingressDomain: string;
  acmeEmail: string;
  domainDns?: string | undefined;
  ingressDns?: string | undefined;
}

export interface ZoneView {
  zone: string;
  nameservers: string[];
  provider?: string | undefined;
  label?: string | undefined;
  problem?: string | undefined;
  credentials: boolean;
  setup?: string | undefined;
}

export interface ServerOrderView extends Omit<ServerOrder, 'sshPrivateKey' | 'setupCode' | 'log'> {
  said: string;
  hasSetupCode: boolean;
  hasSshKey: boolean;
  log?: string[] | undefined;
}

export function viewOf(order: ServerOrder, withLog = false): ServerOrderView {
  const { sshPrivateKey, setupCode, log, ...rest } = order;
  return {
    ...rest,
    said: order.detail ?? STATE_SAID[order.state],
    hasSetupCode: Boolean(setupCode) && !order.setupCodeShownAt,
    hasSshKey: Boolean(sshPrivateKey),
    ...(withLog ? { log: log ?? [] } : {}),
  };
}

export class ServerOrderService {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly dns: DnsProviders;

  constructor(private readonly deps: ServerOrderDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.dns = deps.dns ?? new DnsProviders(this.fetchImpl);
  }

  private async ovh(ownerId: string): Promise<OvhClient> {
    const account = await this.deps.ovhAccountOf(ownerId);
    if (!account) throw new ServerOrderProblem(409, 'Add your OVHcloud keys under Cloud providers first.');
    return new OvhClient(account, this.fetchImpl);
  }

  private async credentialsFor(ownerId: string, provider: string): Promise<DnsCredentials> {
    const described = dnsProviderNamed(provider);
    const found = await this.deps.dnsCredentialsOf(ownerId, provider);
    if (!found) throw new ServerOrderProblem(409, `Add your ${described.label} credentials under Cloud providers first. ${described.setup}`);
    return found;
  }

  private async providerFor(ownerId: string, zone: string, override: string | undefined): Promise<string> {
    const asked = override?.trim();
    const detected = asked ? undefined : await this.dns.detect(zone);
    const provider = asked || detected?.provider;
    if (!provider) throw new ServerOrderProblem(409, detected?.problem ?? `Koala cannot tell who serves ${zone}'s DNS`);
    try {
      await this.dns.zone(provider, await this.credentialsFor(ownerId, provider), zone);
    } catch (error) {
      if (error instanceof DnsProviderRefusal) throw new ServerOrderProblem(409, error.message);
      throw error;
    }
    return provider;
  }

  async zones(ownerId: string, zones: readonly string[]): Promise<ZoneView[]> {
    return Promise.all(zones.map(async (zone) => {
      const found = await this.dns.detect(zone.trim().toLowerCase());
      if (!found.provider) return { zone: found.zone, nameservers: found.nameservers, problem: found.problem, credentials: false };
      const described = dnsProviderNamed(found.provider);
      const credentials = Boolean(await this.deps.dnsCredentialsOf(ownerId, found.provider));
      return { zone: found.zone, nameservers: found.nameservers, provider: found.provider, label: described.label, credentials, ...(credentials ? {} : { setup: described.setup }) };
    }));
  }

  async priceCart(client: OvhClient, planCode: string, datacenter: string): Promise<{ cartId: string; quote: ServerQuote }> {
    const cart = await client.post<{ cartId: string }>('/order/cart', { ovhSubsidiary: client.subsidiary, description: 'Koala root' });
    try {
      await client.post(`/order/cart/${cart.cartId}/assign`);
      const item = await client.post<{ itemId: number }>(`/order/cart/${cart.cartId}/vps`, { planCode, duration: 'P1M', pricingMode: 'default', quantity: 1 });
      const required = await client.get<unknown>(`/order/cart/${cart.cartId}/item/${item.itemId}/requiredConfiguration`);
      for (const entry of configurationFor(required, { vps_datacenter: datacenter, vps_os: ROOT_OS })) {
        await client.post(`/order/cart/${cart.cartId}/item/${item.itemId}/configuration`, entry);
      }
      const options = mandatoryOptions(await client.get<unknown>(`/order/cart/${cart.cartId}/vps/options?planCode=${encodeURIComponent(planCode)}`));
      for (const option of options) {
        await client.post(`/order/cart/${cart.cartId}/vps/options`, { itemId: item.itemId, planCode: option.planCode, duration: 'P1M', pricingMode: 'default', quantity: 1 });
      }
      return { cartId: cart.cartId, quote: quoteFromCheckout(await client.get<unknown>(`/order/cart/${cart.cartId}/checkout`)) };
    } catch (error) {
      await client.delete(`/order/cart/${cart.cartId}`).catch(() => undefined);
      throw error;
    }
  }

  async quoteAndDiscard(ownerId: string, planCode: string, datacenter: string): Promise<ServerQuote> {
    const client = await this.ovh(ownerId);
    const { cartId, quote } = await this.priceCart(client, planCode, datacenter);
    await client.delete(`/order/cart/${cartId}`);
    return quote;
  }

  async quote(ownerId: string, ask: QuoteAsk): Promise<ServerOrderView> {
    const domain = ask.domain.trim().toLowerCase();
    const ingressDomain = ask.ingressDomain.trim().toLowerCase();
    const problem = rootDomainProblem(domain, ingressDomain);
    if (problem) throw new ServerOrderProblem(400, problem);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ask.acmeEmail.trim())) throw new ServerOrderProblem(400, 'Give an email address for the certificate authority and root\'s mail.');
    if (!ask.planCode.trim() || !ask.datacenter.trim()) throw new ServerOrderProblem(400, 'Pick a plan and a datacenter.');
    const dns = { domain: await this.providerFor(ownerId, domain, ask.domainDns), ingress: await this.providerFor(ownerId, ingressDomain, ask.ingressDns) };
    const client = await this.ovh(ownerId);
    const { cartId, quote } = await this.priceCart(client, ask.planCode.trim(), ask.datacenter.trim());
    const at = this.now().toISOString();
    const order: ServerOrder = {
      id: randomUUID(),
      ownerId,
      provider: 'ovh',
      purpose: 'root',
      subsidiary: client.subsidiary,
      planCode: ask.planCode.trim(),
      planLabel: ask.planLabel.trim() || ask.planCode.trim(),
      datacenter: ask.datacenter.trim(),
      domain,
      ingressDomain,
      acmeEmail: ask.acmeEmail.trim(),
      dns,
      cartId,
      quote,
      quotedAt: at,
      state: 'quoted',
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.store.saveServerOrder(order);
    return viewOf(order);
  }

  private async owned(ownerId: string, id: string): Promise<ServerOrder> {
    const order = await this.deps.store.getServerOrder(id);
    if (!order || order.ownerId !== ownerId) throw new ServerOrderProblem(404, 'No such server order');
    return order;
  }

  async list(ownerId: string): Promise<ServerOrderView[]> {
    return (await this.deps.store.getServerOrders(ownerId)).map((order) => viewOf(order));
  }

  async get(ownerId: string, id: string): Promise<ServerOrderView> {
    return viewOf(await this.owned(ownerId, id), true);
  }

  async buy(ownerId: string, id: string, confirmedTotal: unknown): Promise<ServerOrderView> {
    const order = await this.owned(ownerId, id);
    if (order.state !== 'quoted' || !order.cartId) throw new ServerOrderProblem(409, `This order is ${STATE_SAID[order.state].toLowerCase()}, so it cannot be bought.`);
    if (typeof confirmedTotal !== 'number' || !Number.isFinite(confirmedTotal)) throw new ServerOrderProblem(400, 'Send the total you confirmed as "confirmedTotal".');
    const client = await this.ovh(ownerId);
    const now = quoteFromCheckout(await client.get<unknown>(`/order/cart/${order.cartId}/checkout`));
    const changed = priceChangeProblem(order.quote, now, confirmedTotal);
    if (changed) throw new ServerOrderProblem(409, changed);
    const bought = await client.post<{ orderId: number }>(`/order/cart/${order.cartId}/checkout`, { autoPayWithPreferredPaymentMethod: true, waiveRetractationPeriod: true });
    const saved = await this.deps.store.patchServerOrder(id, { state: 'bought', orderId: bought.orderId, boughtAt: this.now().toISOString(), cartId: undefined, detail: undefined });
    await this.deps.store.appendServerOrderLog(id, [`bought: OVHcloud order ${bought.orderId}, ${order.quote.withTax} ${order.quote.currency} charged to your OVHcloud account's payment method`]);
    if (this.deps.startFollowing && saved) {
      const workflowId = await this.deps.startFollowing(saved);
      await this.deps.store.patchServerOrder(id, { workflowId });
    }
    return viewOf((await this.deps.store.getServerOrder(id))!);
  }

  async cancel(ownerId: string, id: string): Promise<ServerOrderView> {
    const order = await this.owned(ownerId, id);
    if (order.state === 'quoted') {
      if (order.cartId) await (await this.ovh(ownerId)).delete(`/order/cart/${order.cartId}`).catch(() => undefined);
      await this.deps.store.patchServerOrder(id, { state: 'quote-cancelled', cartId: undefined, detail: undefined });
      return viewOf((await this.deps.store.getServerOrder(id))!);
    }
    if (FOLLOWING.includes(order.state) && order.workflowId && this.deps.stopFollowing) {
      await this.deps.stopFollowing(order.workflowId);
      return viewOf(order);
    }
    throw new ServerOrderProblem(409, `This order is ${STATE_SAID[order.state].toLowerCase()}; there is nothing to cancel here.`);
  }

  async setupCode(ownerId: string, id: string): Promise<string> {
    const order = await this.owned(ownerId, id);
    if (!order.setupCode) throw new ServerOrderProblem(404, 'Root has not given a setup code yet.');
    if (order.setupCodeShownAt) throw new ServerOrderProblem(410, `The setup code was shown at ${order.setupCodeShownAt}. It is ADMIN_SETUP_CODE in /opt/nowrinkles/apps/backend/.env on the server.`);
    await this.deps.store.patchServerOrder(id, { setupCodeShownAt: this.now().toISOString() });
    return decryptValue(order.setupCode, this.deps.dataKey);
  }

  async sshKey(ownerId: string, id: string): Promise<{ privateKey: string; host?: string | undefined }> {
    const order = await this.owned(ownerId, id);
    if (!order.sshPrivateKey) throw new ServerOrderProblem(404, 'This server has no key from Koala yet.');
    return { privateKey: decryptValue(order.sshPrivateKey, this.deps.dataKey), host: order.ip };
  }

  async order(id: string): Promise<ServerOrder> {
    const order = await this.deps.store.getServerOrder(id);
    if (!order) throw new Error(`no server order ${id}`);
    return order;
  }

  async mark(id: string, state: ServerOrderState, detail?: string, extra: Partial<ServerOrder> = {}): Promise<void> {
    await this.deps.store.patchServerOrder(id, { ...extra, state, detail });
    await this.log(id, [detail ?? STATE_SAID[state]]);
  }

  async log(id: string, lines: readonly string[]): Promise<void> {
    await this.deps.store.appendServerOrderLog(id, lines.map((line) => `${this.now().toISOString().slice(11, 19)} ${line}`));
  }

  async follow(id: string): Promise<{ delivered: boolean }> {
    const order = await this.order(id);
    if (!order.orderId) throw new Error('this order was never bought');
    const client = await this.ovh(order.ownerId);
    const status = await client.get<string>(`/me/order/${order.orderId}/status`);
    const state = orderStateOf(status);
    if (state === 'failed') throw new ServerOrderProblem(409, `OVHcloud ${status === 'cancelled' ? 'cancelled' : 'is cancelling'} order ${order.orderId}; nothing more will happen here.`);
    if (state === 'installing-key') {
      const object = await client.get<{ id?: string; type?: string }>(`/me/order/${order.orderId}/associatedObject`);
      if (!object.id) return { delivered: false };
      if (order.state !== 'installing-key' || order.serviceName !== object.id) await this.mark(id, 'installing-key', undefined, { serviceName: object.id });
      return { delivered: true };
    }
    const next = state === 'unknown' ? order.state : state;
    if (next !== order.state) await this.mark(id, next);
    return { delivered: false };
  }

  async rebuild(id: string, keypair: { publicKey: string; privateKey: string }): Promise<{ ip: string }> {
    const order = await this.order(id);
    if (!order.serviceName) throw new Error('the server is not delivered yet');
    const client = await this.ovh(order.ownerId);
    const images = await client.get<string[]>(`/vps/${order.serviceName}/images/available`);
    let imageId: string | undefined;
    for (const candidate of images) {
      const image = await client.get<{ id?: string; name?: string }>(`/vps/${order.serviceName}/images/available/${candidate}`);
      if (image.name === ROOT_OS) imageId = image.id ?? candidate;
    }
    if (!imageId) throw new ServerOrderProblem(409, `OVHcloud offers no ${ROOT_OS} image for ${order.serviceName}.`);
    await client.post(`/vps/${order.serviceName}/rebuild`, { imageId, publicSshKey: keypair.publicKey.trim(), doNotSendPassword: true });
    const ips = await client.get<string[]>(`/vps/${order.serviceName}/ips`);
    const ip = ips.find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address));
    if (!ip) throw new ServerOrderProblem(409, `OVHcloud lists no IPv4 address for ${order.serviceName}.`);
    await this.mark(id, 'waiting-ssh', undefined, {
      ip,
      sshPublicKey: keypair.publicKey.trim(),
      sshPrivateKey: encryptValue(keypair.privateKey, this.deps.dataKey),
    });
    return { ip };
  }

  async pointDomains(id: string): Promise<{ done: boolean; refused: string[] }> {
    const order = await this.order(id);
    if (!order.ip) throw new Error('the server has no address yet');
    if (order.state !== 'dns') await this.mark(id, 'dns');
    const refused: string[] = [];
    const records = rootDnsRecords(order.domain, order.ingressDomain, order.ip);
    for (const zoneName of [...new Set(records.map((record) => record.zone))]) {
      const provider = zoneName === order.domain ? order.dns.domain : order.dns.ingress;
      let zone: DnsZone;
      try {
        zone = await this.dns.zone(provider, await this.credentialsFor(order.ownerId, provider), zoneName);
      } catch (error) {
        if (error instanceof DnsProviderRefusal) throw new ServerOrderProblem(409, error.message);
        throw error;
      }
      const steps = await this.dns.plan(zone, records.filter((record) => record.zone === zoneName).map((record) => record.wanted));
      const { lines } = await this.dns.apply(zone, steps);
      await this.log(id, lines.map((line) => `${zoneName} (${dnsProviderNamed(provider).label}): ${line}`));
      refused.push(...steps.filter((step) => step.do === 'refuse').map((step) => step.why));
    }
    if (refused.length) await this.mark(id, 'dns', refused.join(' '));
    return { done: refused.length === 0, refused };
  }

  async releaseToInstall(id: string): Promise<string | undefined> {
    const release = newestRelease(this.deps.lsRemote ? await this.deps.lsRemote() : '');
    if (!release) await this.mark(id, 'waiting-release', 'No signed Koala release to install yet; this carries on once one is published.');
    return release;
  }

  async dnsFor(id: string): Promise<{ domainDns: string; ingressDns: string; env: Record<string, string> }> {
    const order = await this.order(id);
    const env: Record<string, string> = {};
    for (const provider of new Set([order.dns.domain, order.dns.ingress])) {
      const described = dnsProviderNamed(provider);
      const found = credentialEnvOf(described, await this.credentialsFor(order.ownerId, provider));
      if (!found) throw new ServerOrderProblem(409, `The ${described.label} credentials are incomplete under Cloud providers; add them again and the install carries on.`);
      Object.assign(env, found);
    }
    return { domainDns: order.dns.domain, ingressDns: order.dns.ingress, env };
  }

  privateKeyOf(order: ServerOrder): string {
    if (!order.sshPrivateKey) throw new Error('the server has no key from Koala yet');
    return decryptValue(order.sshPrivateKey, this.deps.dataKey);
  }

  async ready(id: string, setupCode: string | undefined, release: string): Promise<void> {
    await this.mark(id, 'ready', `Root is running at https://app.${(await this.order(id)).domain}, on ${release}.`, {
      release,
      ...(setupCode ? { setupCode: encryptValue(setupCode, this.deps.dataKey) } : {}),
    });
  }

  async stopped(id: string): Promise<void> {
    const order = await this.order(id);
    if (!FOLLOWING.includes(order.state)) return;
    await this.mark(id, 'stopped', `Koala stopped following this order. ${order.orderId ? `The server was bought (OVHcloud order ${order.orderId}); to stop paying for it, terminate it in OVHcloud's control panel, which emails you a confirmation link and ends it at the end of the month paid for.` : ''}`.trim());
  }

  async failed(id: string, reason: string): Promise<void> {
    if ((await this.order(id)).state === 'ready') {
      await this.log(id, [`root is running, but checking its mail stopped: ${reason}`]);
      return;
    }
    await this.mark(id, 'failed', reason);
  }

  private async noteReverseDns(order: ServerOrder, state: ReverseDnsState, why?: string): Promise<{ done: boolean }> {
    const name = mailHostOf(order.domain);
    const said = reverseDnsSaid(state, order.ip!, name, why);
    if (order.reverseDns?.said !== said) {
      await this.deps.store.patchServerOrder(order.id, { reverseDns: { ip: order.ip!, name, state, said, at: this.now().toISOString() } });
      await this.log(order.id, [`reverse DNS: ${said}`]);
    }
    return { done: state !== 'waiting' };
  }

  async setReverseDns(id: string): Promise<{ done: boolean }> {
    const order = await this.order(id);
    if (!order.ip) throw new Error('the server has no address yet');
    const name = mailHostOf(order.domain);
    let pointed: string[];
    try {
      const zone = await this.dns.zone(order.dns.domain, await this.credentialsFor(order.ownerId, order.dns.domain), order.domain);
      pointed = (await zone.list('A', name)).map((record) => record.content);
    } catch (error) {
      if (error instanceof DnsProviderRefusal || error instanceof ServerOrderProblem) return this.noteReverseDns(order, 'refused', `Koala could not read ${order.domain}'s records: ${error.message}`);
      throw error;
    }
    if (!pointed.includes(order.ip)) {
      return this.noteReverseDns(order, 'refused', pointed.length ? `${name} points at ${pointed.join(', ')}, not ${order.ip}` : `${order.domain} has no A record for ${name}`);
    }
    const client = await this.ovh(order.ownerId);
    try {
      const block = ipBlockFor(await client.get<unknown>(`/ip?ip=${encodeURIComponent(order.ip)}`), order.ip);
      if (!block) return this.noteReverseDns(order, 'refused', `OVHcloud lists no IP block holding ${order.ip} on this account`);
      const current = await client.get<{ reverse?: string }>(reverseDnsPath(block, order.ip)).catch((error: unknown) => {
        if (error instanceof OvhError && error.status === 404) return undefined;
        throw error;
      });
      if (samePtr(current?.reverse, name)) return this.noteReverseDns(order, 'already');
      await client.post(reverseDnsPath(block), { ipReverse: order.ip, reverse: ptrValue(name) });
      return this.noteReverseDns(order, 'set');
    } catch (error) {
      if (!(error instanceof OvhError)) throw error;
      if (error.status < 500 && forwardNotSeen(error.message)) return this.noteReverseDns(order, 'waiting', error.message);
      if (error.status >= 500) throw error;
      return this.noteReverseDns(order, 'refused', error.message);
    }
  }

  async recordMailCheck(id: string, output: string | undefined): Promise<void> {
    const check = output === undefined ? undefined : mailCheckFrom(output);
    if (!check) {
      await this.log(id, ['mail: this release cannot check root\'s mail yet; root\'s admin page checks it once root runs a release that can']);
      return;
    }
    const mail = mailReport(check);
    await this.deps.store.patchServerOrder(id, { mail });
    const { problems } = mail;
    await this.log(id, mail.lines.map((line) => `mail: ${line.mark === 'ok' ? '✓' : line.mark === 'problem' ? '!' : '?'} ${line.said}`));
    await this.log(id, [problems.length ? `mail: ${problems.length} thing${problems.length === 1 ? '' : 's'} to fix before root's mail is relied on` : 'mail: root is ready to send']);
  }
}
