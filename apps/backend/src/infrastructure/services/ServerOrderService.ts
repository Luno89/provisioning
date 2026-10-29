import { randomUUID } from 'node:crypto';
import { decryptValue, encryptValue, type SecretKey } from '../../platform/index.js';
import type { InfrastructureStore } from '../store.js';
import {
  configurationFor, FOLLOWING, mandatoryOptions, newestRelease, orderStateOf, priceChangeProblem, quoteFromCheckout, ROOT_OS,
  rootDnsActions, rootDnsRecords, rootDomainProblem, STATE_SAID, type RootDnsAction, type ServerOrder, type ServerOrderState, type ServerQuote,
} from '../lib/server-orders.js';
import { OvhClient, type FetchLike, type OvhAccount } from './OvhClient.js';

export class ServerOrderProblem extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ServerOrderDeps {
  store: Pick<InfrastructureStore, 'getServerOrders' | 'getServerOrder' | 'saveServerOrder' | 'patchServerOrder' | 'appendServerOrderLog'>;
  dataKey: SecretKey;
  ovhAccountOf: (ownerId: string) => Promise<OvhAccount | undefined>;
  cloudflareTokenOf: (ownerId: string) => Promise<string | undefined>;
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

interface CfZone { id: string; name: string }
interface CfRecord { id: string; name: string; content: string; type: string }

export class ServerOrderService {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly deps: ServerOrderDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  private async ovh(ownerId: string): Promise<OvhClient> {
    const account = await this.deps.ovhAccountOf(ownerId);
    if (!account) throw new ServerOrderProblem(409, 'Add your OVHcloud keys under Cloud providers first.');
    return new OvhClient(account, this.fetchImpl);
  }

  private async cloudflare<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const answer = await this.fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    const body = await answer.json() as { success?: boolean; errors?: { message?: string }[]; result: T };
    if (!body.success) throw new Error(`Cloudflare refused ${path.split('?')[0]}: ${body.errors?.map((error) => error.message).join('; ') || `HTTP ${answer.status}`}`);
    return body.result;
  }

  private async zoneOf(token: string, zone: string): Promise<CfZone> {
    const zones = await this.cloudflare<CfZone[]>(token, `/zones?name=${encodeURIComponent(zone)}`);
    const found = zones.find((entry) => entry.name === zone);
    if (!found) throw new ServerOrderProblem(409, `Your Cloudflare token cannot see the zone ${zone}; give it Zone → DNS → Edit on ${zone}.`);
    return found;
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
    const token = await this.deps.cloudflareTokenOf(ownerId);
    if (!token) throw new ServerOrderProblem(409, 'Add a Cloudflare token under Cloud providers first, with Zone → DNS → Edit on both domains.');
    await this.zoneOf(token, domain);
    await this.zoneOf(token, ingressDomain);
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
    const token = await this.deps.cloudflareTokenOf(order.ownerId);
    if (!token) throw new ServerOrderProblem(409, 'The Cloudflare token is gone from Cloud providers; add it again and the install carries on.');
    if (order.state !== 'dns') await this.mark(id, 'dns');
    const refused: string[] = [];
    for (const wanted of rootDnsRecords(order.domain, order.ingressDomain, order.ip)) {
      const zone = await this.zoneOf(token, wanted.zone);
      const existing = await this.cloudflare<CfRecord[]>(token, `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(wanted.name)}`);
      const [action] = rootDnsActions([wanted], existing) as [RootDnsAction];
      if (action.do === 'create') {
        await this.cloudflare(token, `/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify({ type: 'A', name: wanted.name, content: wanted.content, ttl: 1, proxied: false }) });
        await this.log(id, [`added A ${wanted.name} → ${wanted.content} (DNS only)`]);
      } else if (action.do === 'keep') {
        await this.log(id, [`A ${wanted.name} already → ${wanted.content}`]);
      } else {
        refused.push(action.why);
      }
    }
    if (refused.length) await this.mark(id, 'dns', refused.join(' '));
    return { done: refused.length === 0, refused };
  }

  async releaseToInstall(id: string): Promise<string | undefined> {
    const release = newestRelease(this.deps.lsRemote ? await this.deps.lsRemote() : '');
    if (!release) await this.mark(id, 'waiting-release', 'No signed Koala release to install yet; this carries on once one is published.');
    return release;
  }

  async cloudflareTokenFor(id: string): Promise<string> {
    const order = await this.order(id);
    const token = await this.deps.cloudflareTokenOf(order.ownerId);
    if (!token) throw new ServerOrderProblem(409, 'The Cloudflare token is gone from Cloud providers; add it again and the install carries on.');
    return token;
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
    await this.mark(id, 'failed', reason);
  }
}
