import { beforeEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { FAKE_OVH_KEYS, fakeOvh, type FakeOvhState } from './fake-ovh.js';
import type { FetchLike } from './OvhClient.js';
import { DnsProviders } from './dns/DnsProviders.js';
import { fakeCloudflare, fakePorkbun, type FakeDns } from './dns/fake-dns.js';
import { ServerOrderProblem, ServerOrderService } from './ServerOrderService.js';

const KEY = 'server-order-test-key';
const ASK = { planCode: 'vps-2027-model2', planLabel: 'VPS-2 2027', datacenter: 'SYD', domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com' };

const NAMESERVERS: Record<string, string[]> = {
  'nowrinkles.dev': ['journey.ns.cloudflare.com', 'quinton.ns.cloudflare.com'],
  'nowrinkles.app': ['fortaleza.ns.porkbun.com', 'maceio.ns.porkbun.com'],
};

describe('buying root\'s server from OVHcloud', () => {
  let db: MongoDB;
  let ovh: { fetch: FetchLike; state: FakeOvhState };
  let cf: FakeDns;
  let pb: FakeDns;
  let stored: Record<string, Record<string, string> | undefined>;
  let started: string[];
  let stopped: string[];
  let service: ServerOrderService;
  let lsRemote: string;

  const make = (overrides: Partial<ConstructorParameters<typeof ServerOrderService>[0]> = {}) => new ServerOrderService({
    store: db.infrastructure,
    dataKey: KEY,
    ovhAccountOf: async () => ({ ...FAKE_OVH_KEYS, subsidiary: 'AU' }),
    dnsCredentialsOf: async (_owner, provider) => stored[provider],
    startFollowing: async (order) => { started.push(order.id); return `root-node-${order.id}`; },
    stopFollowing: async (workflowId) => { stopped.push(workflowId); },
    lsRemote: async () => lsRemote,
    fetchImpl: ovh.fetch,
    dns: new DnsProviders((input, init) => (input.startsWith('https://api.cloudflare.com') ? cf.fetch(input, init) : pb.fetch(input, init)), async (zone) => NAMESERVERS[zone] ?? []),
    ...overrides,
  });

  beforeEach(async () => {
    db = await testDatabase();
    ovh = fakeOvh();
    cf = fakeCloudflare(['nowrinkles.dev']);
    pb = fakePorkbun(['nowrinkles.app']);
    stored = { cloudflare: cf.good, porkbun: pb.good };
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

  it('finds each zone\'s DNS provider from its nameservers and keeps it on the order', async () => {
    expect((await service.quote('op', ASK)).dns).toEqual({ domain: 'cloudflare', ingress: 'porkbun' });
    expect(await service.zones('op', ['nowrinkles.dev', 'nowrinkles.app', 'elsewhere.test'])).toEqual([
      { zone: 'nowrinkles.dev', nameservers: NAMESERVERS['nowrinkles.dev'], provider: 'cloudflare', label: 'Cloudflare DNS', credentials: true },
      { zone: 'nowrinkles.app', nameservers: NAMESERVERS['nowrinkles.app'], provider: 'porkbun', label: 'Porkbun DNS', credentials: true },
      { zone: 'elsewhere.test', nameservers: [], problem: expect.stringContaining('no nameservers'), credentials: false },
    ]);
  });

  it('refuses to price before the keys, each zone\'s DNS credentials and access to both zones are there', async () => {
    await expect(make({ ovhAccountOf: async () => undefined }).quote('op', ASK)).rejects.toThrow(/OVHcloud keys/);
    stored = { cloudflare: cf.good };
    await expect(service.quote('op', ASK)).rejects.toThrow(/Add your Porkbun DNS credentials/);
    stored = { cloudflare: cf.good, porkbun: pb.good };
    pb.zones.get('nowrinkles.app')!.reachable = false;
    await expect(service.quote('op', ASK)).rejects.toThrow(/API Access/);
    pb.zones.get('nowrinkles.app')!.reachable = true;
    await expect(service.quote('op', { ...ASK, domain: 'elsewhere.test' })).rejects.toThrow(/no nameservers/);
    await expect(service.quote('op', { ...ASK, ingressDns: 'cloudflare' })).rejects.toThrow(/cannot see the zone nowrinkles.app/);
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
    pb.zones.get('nowrinkles.app')!.records.push({ id: 'r-theirs', type: 'A', name: '*.nowrinkles.app', content: '198.51.100.1' });
    expect(await service.pointDomains(quoted.id)).toMatchObject({ done: false, refused: [expect.stringMatching(/already points at 198.51.100.1/)] });
    expect(cf.zones.get('nowrinkles.dev')!.records.map((record) => `${record.name}→${record.content}`)).toEqual(['app.nowrinkles.dev→203.0.113.7', 'mesh.nowrinkles.dev→203.0.113.7']);
    expect(pb.zones.get('nowrinkles.app')!.records.map((record) => record.content)).toEqual(['198.51.100.1']);
    pb.zones.get('nowrinkles.app')!.records = [];
    expect((await service.pointDomains(quoted.id)).done).toBe(true);
    expect(pb.zones.get('nowrinkles.app')!.records.map((record) => `${record.name}→${record.content}`)).toEqual(['*.nowrinkles.app→203.0.113.7']);
    expect(cf.zones.get('nowrinkles.dev')!.records).toHaveLength(2);
    expect(await service.dnsFor(quoted.id)).toEqual({ domainDns: 'cloudflare', ingressDns: 'porkbun', env: { CLOUDFLARE_API_TOKEN: cf.good.token, PORKBUN_API_KEY: pb.good.apiKey, PORKBUN_API_SECRET_KEY: pb.good.secretApiKey } });
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

  it('seals the sign-in providers\' keys on the order, shows only which were given, and hands them back to the install', async () => {
    const signIn = [{ id: 'github', values: { clientId: 'github-fake-client', clientSecret: 'github-client-secret-0123' } }];
    const quoted = await service.quote('op', { ...ASK, signIn });
    expect(quoted.signIn).toEqual([{ id: 'github', label: 'GitHub' }]);
    expect(JSON.stringify(quoted)).not.toMatch(/github-client-secret-0123|github-fake-client|signInEnv/);
    const stored = await db.infrastructure.getServerOrder(quoted.id);
    expect(stored?.signInEnv).toMatch(/^v2:/);
    expect(stored?.signInEnv).not.toContain('github-client-secret-0123');
    expect(await service.signInFor(quoted.id)).toEqual({ GITHUB_CLIENT_ID: 'github-fake-client', GITHUB_CLIENT_SECRET: 'github-client-secret-0123' });
    for (const view of [await service.get('op', quoted.id), ...(await service.list('op'))]) expect(JSON.stringify(view)).not.toMatch(/github-client-secret-0123|signInEnv/);
    const plain = await service.quote('op', ASK);
    expect(plain.signIn).toEqual([]);
    expect(await service.signInFor(plain.id)).toEqual({});
    const carts = ovh.state.calls.filter((call) => call === 'POST /order/cart').length;
    await expect(service.quote('op', { ...ASK, signIn: [{ id: 'github', values: { clientId: 'only-the-id' } }] })).rejects.toThrow(/GITHUB_CLIENT_SECRET is not set/);
    expect(ovh.state.calls.filter((call) => call === 'POST /order/cart').length).toBe(carts);
  });

  it('prices a plan and throws the cart away, for checking the keys and the price without buying', async () => {
    const quote = await service.quoteAndDiscard('op', 'vps-2027-model2', 'SYD');
    expect(quote).toMatchObject({ currency: 'AUD', withTax: 15.4 });
    expect(ovh.state.deletedCarts).toEqual(['cart-1']);
    expect(ovh.state.checkedOut).toBe(0);
    expect(await db.infrastructure.getServerOrders('op')).toEqual([]);
  });
});
