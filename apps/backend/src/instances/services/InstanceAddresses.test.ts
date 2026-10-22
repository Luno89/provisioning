import { describe, expect, it } from 'vitest';
import { InstanceAddresses } from './InstanceAddresses.js';

const settings = { rootUrl: 'https://root', instanceId: 'inst-1', credential: 'secret', name: 'luno' };

function rootAnswering(views: object[]) {
  const asked: Array<{ method: string; body?: string | undefined; headers: Record<string, string> }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    asked.push({ method: String(init.method), body: init.body as string | undefined, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(views.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

describe('an instance\'s addresses', () => {
  it('asks root as the instance, and republishes its apps only when nested addresses become ready or stop', async () => {
    const { asked, fetchImpl } = rootAnswering([
      { nested: true, state: 'issuing', name: 'luno', domain: 'koala.dev' },
      { nested: true, state: 'ready', name: 'luno', domain: 'koala.dev' },
      { nested: true, state: 'ready', name: 'luno', domain: 'koala.dev' },
      { nested: false, name: 'luno', domain: 'koala.dev' },
    ]);
    let republished = 0;
    const addresses = new InstanceAddresses(settings, async () => { republished += 1; }, fetchImpl, 60_000);
    await addresses.set(true);
    expect(asked[0]).toMatchObject({ method: 'PUT', body: '{"nested":true}', headers: { 'x-instance-id': 'inst-1', authorization: 'Bearer secret' } });
    expect(addresses.nestedReady()).toBe(false);
    expect(republished).toBe(0);
    await addresses.refresh();
    expect(addresses.nestedReady()).toBe(true);
    expect(republished).toBe(1);
    await addresses.refresh();
    expect(republished).toBe(1);
    await addresses.set(false);
    expect(addresses.nestedReady()).toBe(false);
    expect(republished).toBe(2);
    addresses.stop();
  });

  it('says what root said when it refuses', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'no INGRESS_DOMAIN' }), { status: 503 })) as unknown as typeof fetch;
    await expect(new InstanceAddresses(settings, async () => {}, fetchImpl).refresh()).rejects.toThrow(/503.*no INGRESS_DOMAIN/);
  });
});
