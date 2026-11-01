import { beforeEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { MAIL_CHECK_MARK } from '../../platform/lib/mail-reputation.js';
import { FAKE_OVH_KEYS, fakeOvh, type FakeOvhState } from './fake-ovh.js';
import type { FetchLike } from './OvhClient.js';
import { DnsProviders } from './dns/DnsProviders.js';
import { fakeCloudflare, fakePorkbun, type FakeDns } from './dns/fake-dns.js';
import { ServerOrderService } from './ServerOrderService.js';
import { matching, listContaining } from './test-matchers.js';

const ASK = { planCode: 'vps-2027-model2', planLabel: 'VPS-2 2027', datacenter: 'SYD', domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com' };
const NAMESERVERS: Record<string, string[]> = {
  'nowrinkles.dev': ['journey.ns.cloudflare.com', 'quinton.ns.cloudflare.com'],
  'nowrinkles.app': ['fortaleza.ns.porkbun.com', 'maceio.ns.porkbun.com'],
};

describe('root\'s mail once its server is bought', () => {
  let db: MongoDB;
  let ovh: { fetch: FetchLike; state: FakeOvhState };
  let cf: FakeDns;
  let pb: FakeDns;
  let service: ServerOrderService;

  const readyOrder = async (): Promise<string> => {
    const quoted = await service.quote('op', ASK);
    await service.buy('op', quoted.id, 15.4);
    await service.follow(quoted.id);
    await service.rebuild(quoted.id, { publicKey: 'ssh-ed25519 AAAA koala', privateKey: 'k' });
    await service.pointDomains(quoted.id);
    await service.ready(quoted.id, undefined, 'v2026.10.29');
    return quoted.id;
  };
  const mailRecord = (content: string) => cf.zones.get('nowrinkles.dev')!.records.push({ id: `r-mail-${content}`, type: 'A', name: 'mail.nowrinkles.dev', content });

  beforeEach(async () => {
    db = await testDatabase();
    ovh = fakeOvh();
    cf = fakeCloudflare(['nowrinkles.dev']);
    pb = fakePorkbun(['nowrinkles.app']);
    const stored: Record<string, Record<string, string>> = { cloudflare: cf.good, porkbun: pb.good };
    service = new ServerOrderService({
      store: db.infrastructure,
      dataKey: 'server-order-mail-test-key',
      ovhAccountOf: async () => ({ ...FAKE_OVH_KEYS, subsidiary: 'US' }),
      dnsCredentialsOf: async (_owner, provider) => stored[provider],
      startFollowing: async (order) => `root-node-${order.id}`,
      lsRemote: async () => 'a\trefs/tags/v2026.10.29\n',
      fetchImpl: ovh.fetch,
      dns: new DnsProviders((input, init) => (input.startsWith('https://api.cloudflare.com') ? cf.fetch(input, init) : pb.fetch(input, init)), async (zone) => NAMESERVERS[zone] ?? []),
    });
  });

  it('sets the reverse DNS of the server\'s address to mail.<domain> through OVHcloud\'s IP API, once', async () => {
    const id = await readyOrder();
    mailRecord('203.0.113.7');
    expect(await service.setReverseDns(id)).toEqual({ done: true });
    expect(ovh.state.reverses).toEqual({ '203.0.113.7': 'mail.nowrinkles.dev.' });
    expect(ovh.state.calls).toEqual(listContaining(['GET /ip?ip=203.0.113.7', 'GET /ip/203.0.113.7%2F32/reverse/203.0.113.7', 'POST /ip/203.0.113.7%2F32/reverse']));
    expect((await service.get('op', id)).reverseDns).toMatchObject({ ip: '203.0.113.7', name: 'mail.nowrinkles.dev', state: 'set', said: 'OVHcloud set the reverse DNS of 203.0.113.7 to mail.nowrinkles.dev' });
    const posts = () => ovh.state.calls.filter((call) => call.startsWith('POST /ip/')).length;
    expect(posts()).toBe(1);
    expect(await service.setReverseDns(id)).toEqual({ done: true });
    expect(posts()).toBe(1);
    expect((await service.get('op', id)).reverseDns?.state).toBe('already');
    expect((await service.get('op', id)).state).toBe('ready');
  });

  it('waits while OVHcloud does not yet see the name point at the address, then sets it', async () => {
    const id = await readyOrder();
    mailRecord('203.0.113.7');
    ovh.state.reverseRefusal = { status: 400, message: 'Cannot check if mail.nowrinkles.dev. resolves to 203.0.113.7' };
    expect(await service.setReverseDns(id)).toEqual({ done: false });
    expect((await service.get('op', id)).reverseDns).toMatchObject({ state: 'waiting', said: matching(/^waiting for OVHcloud to see mail\.nowrinkles\.dev point at 203\.0\.113\.7/) });
    const logged = (await service.get('op', id)).log!.filter((line) => line.includes('reverse DNS')).length;
    expect(await service.setReverseDns(id)).toEqual({ done: false });
    expect((await service.get('op', id)).log!.filter((line) => line.includes('reverse DNS'))).toHaveLength(logged);
    ovh.state.reverseRefusal = undefined;
    expect(await service.setReverseDns(id)).toEqual({ done: true });
    expect(ovh.state.reverses['203.0.113.7']).toBe('mail.nowrinkles.dev.');
  });

  it('says why and what to do by hand when OVHcloud refuses, or the name points elsewhere', async () => {
    const id = await readyOrder();
    ovh.state.reverseRefusal = { status: 403, message: 'This call has not been granted' };
    expect(await service.setReverseDns(id)).toEqual({ done: true });
    expect((await service.get('op', id)).reverseDns).toMatchObject({ state: 'refused', said: matching(/has no A record for mail\.nowrinkles\.dev.*Modify the reverse path/) });
    mailRecord('198.51.100.1');
    expect(await service.setReverseDns(id)).toEqual({ done: true });
    expect((await service.get('op', id)).reverseDns?.said).toMatch(/mail\.nowrinkles\.dev points at 198\.51\.100\.1, not 203\.0\.113\.7/);
    cf.zones.get('nowrinkles.dev')!.records = cf.zones.get('nowrinkles.dev')!.records.filter((record) => record.name !== 'mail.nowrinkles.dev');
    mailRecord('203.0.113.7');
    expect(await service.setReverseDns(id)).toEqual({ done: true });
    expect((await service.get('op', id)).reverseDns).toMatchObject({ state: 'refused', said: matching(/OVHcloud answered 403: This call has not been granted; set the reverse DNS \(PTR\) of 203\.0\.113\.7 to mail\.nowrinkles\.dev/) });
    expect(ovh.state.reverses).toEqual({});
  });

  it('keeps what root\'s own mail check found on the order, and never fails a running root over it', async () => {
    const id = await readyOrder();
    const check = {
      domain: 'nowrinkles.dev', host: 'mail.nowrinkles.dev', ip: '203.0.113.7', checkedAt: '2026-10-30T00:00:00.000Z',
      forward: { state: 'matches', addresses: ['203.0.113.7'], said: 'mail.nowrinkles.dev points at 203.0.113.7' },
      reverseDns: { state: 'matches', names: ['mail.nowrinkles.dev'], said: '203.0.113.7 reverses to mail.nowrinkles.dev' },
      port25: { open: true, said: 'outbound port 25 is open' },
      blocklists: [{ name: 'UCEPROTECT level 1', zone: 'dnsbl-1.uceprotect.net', state: 'listed', codes: ['127.0.0.2'], said: '203.0.113.7 is on UCEPROTECT level 1 (127.0.0.2)' }],
    };
    await service.recordMailCheck(id, `  ✓ lines\n${MAIL_CHECK_MARK} ${JSON.stringify(check)}`);
    const order = await service.get('op', id);
    expect(order.mail).toMatchObject({ check: { ip: '203.0.113.7', blocklists: [{ state: 'listed' }] }, problems: [matching(/UCEPROTECT/)], lines: listContaining([{ mark: 'problem', said: matching(/UCEPROTECT/) }]) });
    expect(order.log!.slice(-2)).toEqual([matching(/mail: ! 203\.0\.113\.7 is on UCEPROTECT level 1/), matching(/mail: 1 thing to fix before root's mail is relied on/)]);
    await service.recordMailCheck(id, undefined);
    expect((await service.get('op', id)).log!.at(-1)).toMatch(/this release cannot check root's mail yet/);
    await service.failed(id, 'the reverse DNS step failed five times');
    expect((await service.get('op', id))).toMatchObject({ state: 'ready', log: listContaining([matching(/root is running, but checking its mail stopped: the reverse DNS step failed five times/)]) });
  });
});
