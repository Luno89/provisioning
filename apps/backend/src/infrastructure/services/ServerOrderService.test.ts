import { beforeEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { FAKE_OVH_KEYS, fakeOvh, type FakeOvhState } from './fake-ovh.js';
import type { FetchLike } from './OvhClient.js';
import { ServerOrderProblem, ServerOrderService } from './ServerOrderService.js';

const KEY = 'server-order-test-key';
const ASK = { planCode: 'vps-2027-model2', planLabel: 'VPS-2 2027', datacenter: 'SYD', domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com' };

interface CfState { zones: string[]; records: { id: string; zone: string; name: string; content: string }[]; created: string[] }

function fakeCloudflare(state: CfState): FetchLike {
  const json = (result: unknown, success = true) => new Response(JSON.stringify({ success, result, errors: success ? [] : [{ message: 'no' }] }));
  return async (input, init = {}) => {
    const url = new URL(input);
    if ((init.headers as Record<string, string>).authorization !== 'Bearer cf-token') return json(null, false);
    const zoneMatch = /^\/client\/v4\/zones\/([^/]+)\/dns_records$/.exec(url.pathname);
    if (url.pathname === '/client/v4/zones') {
      const name = url.searchParams.get('name');
      return json(state.zones.filter((zone) => zone === name).map((zone) => ({ id: `z-${zone}`, name: zone })));
    }
    if (zoneMatch && (init.method ?? 'GET') === 'GET') {
      return json(state.records.filter((record) => `z-${record.zone}` === zoneMatch[1] && record.name === url.searchParams.get('name')).map((record) => ({ ...record, type: 'A' })));
    }
    if (zoneMatch && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string; content: string; proxied: boolean };
      state.created.push(`${body.name}→${body.content}${body.proxied ? ' proxied' : ''}`);
      return json({ id: 'r-new' });
    }
    return json(null, false);
  };
}

describe('buying root\'s server from OVHcloud', () => {
  let db: MongoDB;
  let ovh: { fetch: FetchLike; state: FakeOvhState };
  let cf: CfState;
  let started: string[];
  let stopped: string[];
  let service: ServerOrderService;
  let lsRemote: string;

  const make = (overrides: Partial<ConstructorParameters<typeof ServerOrderService>[0]> = {}) => new ServerOrderService({
    store: db.infrastructure,
    dataKey: KEY,
    ovhAccountOf: async () => ({ ...FAKE_OVH_KEYS, subsidiary: 'AU' }),
    cloudflareTokenOf: async () => 'cf-token',
    startFollowing: async (order) => { started.push(order.id); return `root-node-${order.id}`; },
    stopFollowing: async (workflowId) => { stopped.push(workflowId); },
    lsRemote: async () => lsRemote,
    fetchImpl: (input, init) => (input.startsWith('https://api.cloudflare.com') ? fakeCloudflare(cf)(input, init) : ovh.fetch(input, init)),
    ...overrides,
  });

  beforeEach(async () => {
    db = await testDatabase();
    ovh = fakeOvh();
    cf = { zones: ['nowrinkles.dev', 'nowrinkles.app'], records: [], created: [] };
    started = [];
    stopped = [];
    lsRemote = 'a\trefs/tags/v2026.10.29\n';
    service = make();
  });

  it('prices a cart with the plan, the datacenter, Ubuntu and every mandatory option, and buys nothing', async () => {
    const order = await service.quote('op', ASK);
    expect(order).toMatchObject({ state: 'quoted', subsidiary: 'AU', quote: { currency: 'AUD', withTax: 15.4, monthly: 14, setupFee: 0 }, hasSetupCode: false, hasSshKey: false });
    expect(order.quote.contracts).toEqual([{ name: 'General Terms of Service', url: 'https://example.ovh/terms.pdf' }]);
    expect(ovh.state.calls).toEqual(expect.arrayContaining([
      'POST /order/cart', 'POST /order/cart/cart-1/assign', 'POST /order/cart/cart-1/vps',
      'POST /order/cart/cart-1/item/7/configuration', 'GET /order/cart/cart-1/vps/options?planCode=vps-2027-model2',
      'GET /order/cart/cart-1/checkout',
    ]));
    expect(ovh.state.calls.filter((call) => call === 'POST /order/cart/cart-1/vps/options')).toHaveLength(3);
    expect(ovh.state.checkedOut).toBe(0);
    expect(started).toEqual([]);
  });

  it('refuses to price before the keys, the token and both zones are there', async () => {
    await expect(make({ ovhAccountOf: async () => undefined }).quote('op', ASK)).rejects.toThrow(/OVHcloud keys/);
    await expect(make({ cloudflareTokenOf: async () => undefined }).quote('op', ASK)).rejects.toThrow(/Cloudflare token/);
    cf.zones = ['nowrinkles.dev'];
    await expect(service.quote('op', ASK)).rejects.toThrow(/cannot see the zone nowrinkles.app/);
    await expect(service.quote('op', { ...ASK, ingressDomain: 'people.nowrinkles.dev' })).rejects.toBeInstanceOf(ServerOrderProblem);
    expect(ovh.state.checkedOut).toBe(0);
  });

  it('buys only at the confirmed price that OVHcloud still asks, once, then follows the order', async () => {
    const quoted = await service.quote('op', ASK);
    await expect(service.buy('op', quoted.id, 14)).rejects.toThrow(/You confirmed 14 AUD/);
    ovh.state.withTax = 16.5;
    await expect(service.buy('op', quoted.id, 15.4)).rejects.toThrow(/now prices this at 16.5 AUD/);
    expect(ovh.state.checkedOut).toBe(0);
    ovh.state.withTax = 15.4;
    const bought = await service.buy('op', quoted.id, 15.4);
    expect(bought).toMatchObject({ state: 'bought', orderId: 123456, workflowId: `root-node-${quoted.id}` });
    expect(ovh.state.checkedOut).toBe(1);
    expect(started).toEqual([quoted.id]);
    await expect(service.buy('op', quoted.id, 15.4)).rejects.toThrow(/cannot be bought/);
    expect(ovh.state.checkedOut).toBe(1);
    await expect(service.buy('someone-else', quoted.id, 15.4)).rejects.toThrow(/No such server order/);
  });

  it('cancels a quote by deleting its cart, and stops following a bought one', async () => {
    const quoted = await service.quote('op', ASK);
    expect((await service.cancel('op', quoted.id)).state).toBe('quote-cancelled');
    expect(ovh.state.deletedCarts).toEqual(['cart-1']);
    const other = await service.quote('op', ASK);
    await service.buy('op', other.id, 15.4);
    await service.cancel('op', other.id);
    expect(stopped).toEqual([`root-node-${other.id}`]);
    await service.stopped(other.id);
    expect((await service.get('op', other.id)).said).toMatch(/bought \(OVHcloud order 123456\); to stop paying for it, terminate it/);
  });

  it('follows OVHcloud\'s check and delivery, then installs Ubuntu with Koala\'s key and seals it', async () => {
    const quoted = await service.quote('op', ASK);
    await service.buy('op', quoted.id, 15.4);
    ovh.state.status = 'checking';
    expect(await service.follow(quoted.id)).toEqual({ delivered: false });
    expect((await service.get('op', quoted.id)).state).toBe('waiting-check');
    ovh.state.status = 'delivered';
    expect(await service.follow(quoted.id)).toEqual({ delivered: true });
    expect((await service.get('op', quoted.id)).serviceName).toBe('vps-a1b2c3.vps.ovh.ca');
    expect(await service.rebuild(quoted.id, { publicKey: 'ssh-ed25519 AAAA koala\n', privateKey: 'PRIVATE-KEY-TEXT' })).toEqual({ ip: '203.0.113.7' });
    expect(ovh.state.rebuilt).toEqual([{ serviceName: 'vps-a1b2c3.vps.ovh.ca', body: { imageId: 'img-ubuntu', publicSshKey: 'ssh-ed25519 AAAA koala', doNotSendPassword: true } }]);
    const stored = await db.infrastructure.getServerOrder(quoted.id);
    expect(stored?.sshPrivateKey).toBeDefined();
    expect(stored?.sshPrivateKey).not.toContain('PRIVATE-KEY-TEXT');
    expect(await service.sshKey('op', quoted.id)).toEqual({ privateKey: 'PRIVATE-KEY-TEXT', host: '203.0.113.7' });
    ovh.state.status = 'cancelled';
    await expect(service.follow(quoted.id)).rejects.toThrow(/cancelled order 123456/);
  });

  it('points the domains at the server, never rewrites a record it did not make, and waits for a release', async () => {
    const quoted = await service.quote('op', ASK);
    await service.buy('op', quoted.id, 15.4);
    await service.follow(quoted.id);
    await service.rebuild(quoted.id, { publicKey: 'ssh-ed25519 AAAA koala', privateKey: 'k' });
    cf.records = [{ id: 'r1', zone: 'nowrinkles.app', name: '*.nowrinkles.app', content: '198.51.100.1' }];
    expect(await service.pointDomains(quoted.id)).toMatchObject({ done: false, refused: [expect.stringMatching(/already points at 198.51.100.1/)] });
    expect(cf.created).toEqual(['app.nowrinkles.dev→203.0.113.7', 'mesh.nowrinkles.dev→203.0.113.7']);
    cf.records = [];
    cf.created = [];
    expect((await service.pointDomains(quoted.id)).done).toBe(true);
    expect(cf.created).toContain('*.nowrinkles.app→203.0.113.7');
    lsRemote = '';
    expect(await service.releaseToInstall(quoted.id)).toBeUndefined();
    expect((await service.get('op', quoted.id)).state).toBe('waiting-release');
    lsRemote = 'a\trefs/tags/v2026.10.29\nb\trefs/tags/v2026.10.30\n';
    expect(await service.releaseToInstall(quoted.id)).toBe('v2026.10.30');
  });

  it('gives the setup code once, sealed until then', async () => {
    const quoted = await service.quote('op', ASK);
    await expect(service.setupCode('op', quoted.id)).rejects.toThrow(/not given a setup code/);
    await service.ready(quoted.id, '0123456789abcdef0123456789abcdef', 'v2026.10.29');
    expect((await db.infrastructure.getServerOrder(quoted.id))?.setupCode).not.toContain('0123456789abcdef');
    expect((await service.get('op', quoted.id))).toMatchObject({ state: 'ready', hasSetupCode: true, said: 'Root is running at https://app.nowrinkles.dev, on v2026.10.29.' });
    expect(await service.setupCode('op', quoted.id)).toBe('0123456789abcdef0123456789abcdef');
    await expect(service.setupCode('op', quoted.id)).rejects.toThrow(/was shown at/);
    expect((await service.get('op', quoted.id)).hasSetupCode).toBe(false);
  });

  it('prices a plan and throws the cart away, for checking the keys and the price without buying', async () => {
    const quote = await service.quoteAndDiscard('op', 'vps-2027-model2', 'SYD');
    expect(quote).toMatchObject({ currency: 'AUD', withTax: 15.4 });
    expect(ovh.state.deletedCarts).toEqual(['cart-1']);
    expect(ovh.state.checkedOut).toBe(0);
    expect(await db.infrastructure.getServerOrders('op')).toEqual([]);
  });
});
