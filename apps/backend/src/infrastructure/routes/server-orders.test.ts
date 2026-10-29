import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import express from 'express';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { authorize, type Principal } from '../../platform/lib/permissions.js';
import { FAKE_OVH_KEYS, fakeOvh } from '../services/fake-ovh.js';
import { ServerOrderService } from '../services/ServerOrderService.js';
import { serverOrdersRouter } from './server-orders.js';

const operatorOnly: express.RequestHandler = (req, res, next) => {
  const decision = authorize((req as unknown as { principal: Principal }).principal, 'administer', { kind: 'install' });
  if (!decision.allowed) return res.status(decision.status).json({ error: decision.error });
  next();
};

const cloudflare = async () => new Response(JSON.stringify({ success: true, result: [{ id: 'z', name: 'nowrinkles.dev' }, { id: 'z2', name: 'nowrinkles.app' }] }));
const ASK = { planCode: 'vps-2027-model2', planLabel: 'VPS-2 2027', datacenter: 'SYD', domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com' };
const send = { validateStatus: () => true };

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

async function mount() {
  const ovh = fakeOvh();
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
        cloudflareTokenOf: async () => 'cf-token',
        startFollowing: async (order) => { started.push(order.id); return `root-node-${order.id}`; },
        fetchImpl: (input, init) => (input.startsWith('https://api.cloudflare.com') ? cloudflare() : ovh.fetch(input, init)),
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

  it('prices, buys only with the confirmed total, and shows no secret in what it lists', async () => {
    const { h, ovh, started } = await mount();
    const quoted = await axios.post(h.url('/api/server-orders/quote'), ASK, send);
    expect(quoted.status).toBe(201);
    expect(ovh.state.checkedOut).toBe(0);
    const id = quoted.data.id as string;
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

  it('answers the setup code and the SSH key uncached, and only when there is one', async () => {
    const { h } = await mount();
    const id = (await axios.post(h.url('/api/server-orders/quote'), ASK, send)).data.id as string;
    const code = await axios.post(h.url(`/api/server-orders/${id}/setup-code`), {}, send);
    expect(code.status).toBe(404);
    expect(code.headers['cache-control']).toBe('no-store');
    expect((await axios.post(h.url(`/api/server-orders/${id}/ssh-key`), {}, send)).status).toBe(404);
  });
});
