import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import express from 'express';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { authorize, type Principal } from '../../platform/lib/permissions.js';
import { FAKE_OVH_KEYS, fakeOvh } from '../services/fake-ovh.js';
import { ServerOrderService } from '../services/ServerOrderService.js';
import { DnsProviders } from '../services/dns/DnsProviders.js';
import { fakeCloudflare } from '../services/dns/fake-dns.js';
import { serverOrdersRouter } from './server-orders.js';

const operatorOnly: express.RequestHandler = (req, res, next) => {
  const decision = authorize((req as unknown as { principal: Principal }).principal, 'administer', { kind: 'install' });
  if (!decision.allowed) return res.status(decision.status).json({ error: decision.error });
  next();
};

const ASK = { planCode: 'vps-2027-model2', planLabel: 'VPS-2 2027', datacenter: 'SYD', domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com' };
const send = { validateStatus: () => true };

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

async function mount() {
  const ovh = fakeOvh();
  const cf = fakeCloudflare(['nowrinkles.dev', 'nowrinkles.app']);
  const started: string[] = [];
  harness = await mountRouter({
    prefix: '/api/server-orders',
    user: { ...TEST_USER, roles: ['operator'] },
    router: (db) => serverOrdersRouter({
      operatorOnly,
      serverOrders: new ServerOrderService({
        store: db.infrastructure,
        dataKey: 'route-test-key',
        ovhAccountOf: async () => ({ ...FAKE_OVH_KEYS, subsidiary: 'AU' }),
        dnsCredentialsOf: async (_owner, provider) => (provider === 'cloudflare' ? cf.good : undefined),
        startFollowing: async (order) => { started.push(order.id); return `root-node-${order.id}`; },
        fetchImpl: ovh.fetch,
        dns: new DnsProviders(cf.fetch, async () => ['a.ns.cloudflare.com', 'b.ns.cloudflare.com']),
      }),
    }),
  });
  return { ovh, started, h: harness };
}

describe('/api/server-orders', () => {
  it('is the operator\'s alone', async () => {
    const { h } = await mount();
    h.setUser(TEST_USER);
    expect((await axios.get(h.url('/api/server-orders'), send)).status).toBe(403);
    expect((await axios.post(h.url('/api/server-orders/quote'), ASK, send)).status).toBe(403);
  });

  it('says who serves each zone\'s DNS and whether its credentials are stored, refusing a request naming none or three', async () => {
    const { h } = await mount();
    const answer = await axios.get<{ zone: string; provider: string; credentials: boolean }[]>(h.url('/api/server-orders/zones?zone=nowrinkles.dev&zone=nowrinkles.app'), send);
    expect(answer.status).toBe(200);
    expect(answer.data.map((zone) => [zone.zone, zone.provider, zone.credentials])).toEqual([['nowrinkles.dev', 'cloudflare', true], ['nowrinkles.app', 'cloudflare', true]]);
    expect((await axios.get(h.url('/api/server-orders/zones'), send)).status).toBe(400);
    expect((await axios.get(h.url('/api/server-orders/zones?zone=a.test&zone=b.test&zone=c.test'), send)).status).toBe(400);
  });

  it('prices, buys only with the confirmed total, and shows no secret in what it lists', async () => {
    const { h, ovh, started } = await mount();
    const quoted = await axios.post<{ id: string }>(h.url('/api/server-orders/quote'), ASK, send);
    expect(quoted.status).toBe(201);
    expect(ovh.state.checkedOut).toBe(0);
    const id = quoted.data.id;
    expect((await axios.post(h.url(`/api/server-orders/${id}/buy`), {}, send)).status).toBe(400);
    expect((await axios.post(h.url(`/api/server-orders/${id}/buy`), { confirmedTotal: 1 }, send)).status).toBe(409);
    expect(ovh.state.checkedOut).toBe(0);
    const bought = await axios.post(h.url(`/api/server-orders/${id}/buy`), { confirmedTotal: 15.4 }, send);
    expect(bought.status).toBe(200);
    expect(bought.data).toMatchObject({ state: 'bought', orderId: 123456 });
    expect(started).toEqual([id]);
    const listed = await axios.get(h.url('/api/server-orders'), send);
    expect(JSON.stringify(listed.data)).not.toMatch(/sshPrivateKey|setupCode"/);
    expect((await axios.get(h.url('/api/server-orders/nope'), send)).status).toBe(404);
  });

  it('describes the sign-in providers root can be given, with root\'s redirect URI for each once the domain is a domain', async () => {
    const { h } = await mount();
    const listed = await axios.get<{ id: string; redirectUri?: string }[]>(h.url('/api/server-orders/sign-in-providers?domain=nowrinkles.dev'), send);
    expect(listed.status).toBe(200);
    expect(listed.data.map((provider) => [provider.id, provider.redirectUri])).toEqual([
      ['google', 'https://app.nowrinkles.dev/api/auth/provider/google/callback'],
      ['github', 'https://app.nowrinkles.dev/api/auth/provider/github/callback'],
      ['oidc', 'https://app.nowrinkles.dev/api/auth/provider/oidc/callback'],
    ]);
    expect((await axios.get<{ redirectUri?: string }[]>(h.url('/api/server-orders/sign-in-providers'), send)).data[0]?.redirectUri).toBeUndefined();
    h.setUser(TEST_USER);
    expect((await axios.get(h.url('/api/server-orders/sign-in-providers'), send)).status).toBe(403);
  });

  it('never sends a sign-in secret back, in any answer about the order', async () => {
    const { h } = await mount();
    const secrets = /google-fake-route-secret|route-client-id|signInEnv|sshPrivateKey|"setupCode"/;
    const signIn = [{ id: 'google', values: { clientId: 'route-client-id', clientSecret: 'google-fake-route-secret' } }];
    expect((await axios.post(h.url('/api/server-orders/quote'), { ...ASK, signIn: [{ id: 'google', values: { clientId: 'route-client-id' } }] }, send)).status).toBe(400);
    const quoted = await axios.post<{ id: string; signIn: unknown }>(h.url('/api/server-orders/quote'), { ...ASK, signIn }, send);
    expect(quoted.status).toBe(201);
    expect(quoted.data.signIn).toEqual([{ id: 'google', label: 'Google' }]);
    const id = quoted.data.id;
    const answers = [
      quoted,
      await axios.get(h.url('/api/server-orders'), send),
      await axios.get(h.url(`/api/server-orders/${id}`), send),
      await axios.post(h.url(`/api/server-orders/${id}/buy`), { confirmedTotal: 15.4 }, send),
      await axios.get(h.url(`/api/server-orders/${id}`), send),
      await axios.delete(h.url(`/api/server-orders/${id}`), send),
      await axios.post(h.url(`/api/server-orders/${id}/setup-code`), {}, send),
      await axios.post(h.url(`/api/server-orders/${id}/ssh-key`), {}, send),
    ];
    for (const answer of answers) expect(JSON.stringify(answer.data)).not.toMatch(secrets);
  });

  it('answers the setup code and the SSH key uncached, and only when there is one', async () => {
    const { h } = await mount();
    const id = (await axios.post<{ id: string }>(h.url('/api/server-orders/quote'), ASK, send)).data.id;
    const code = await axios.post(h.url(`/api/server-orders/${id}/setup-code`), {}, send);
    expect(code.status).toBe(404);
    expect(code.headers['cache-control']).toBe('no-store');
    expect((await axios.post(h.url(`/api/server-orders/${id}/ssh-key`), {}, send)).status).toBe(404);
  });
});
