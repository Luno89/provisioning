import type { Agent } from 'undici';
import { describe, expect, it } from 'vitest';
import { matches, mock, mockFn } from 'vitest-mock-extended';
import { caddyFetch, InstanceReach, instanceReachFrom, type CaddyTransport, type ReachFetchers } from './InstanceReach.js';
import { reachSettingsFrom } from '../lib/instance-reach.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const production = reachSettingsFrom({ NODE_ENV: 'production', INGRESS_DOMAIN: 'people.example', CADDY_TLS_ADDRESS: '127.0.0.1:8443' }, false);
const answer = (via: string): Response => Response.json({ via });

function fetchers(): ReachFetchers {
  const fakes = mock<ReachFetchers>();
  fakes.open.mockResolvedValue(answer('open'));
  fakes.public.mockResolvedValue(answer('public'));
  fakes.viaCaddy.mockResolvedValue(answer('caddy'));
  fakes.publicProblem.mockResolvedValue(undefined);
  return fakes;
}

describe('root calling one of its people\'s instances', () => {
  it('goes through its own Caddy for a name under the people\'s domain, naming the instance for TLS, and never follows a redirect', async () => {
    const fakes = fetchers();
    const reach = new InstanceReach(production, fakes);
    const got = await reach.fetchFor({ name: 'luno' })('https://luno.people.example/api/x', { method: 'POST' });
    expect(await got.json()).toEqual({ via: 'caddy' });
    expect(fakes.viaCaddy).toHaveBeenCalledWith(
      new URL('https://luno.people.example/api/x'),
      { method: 'POST', redirect: 'manual' },
      { host: '127.0.0.1', port: 8443, servername: 'luno.people.example' },
    );
    expect(fakes.public).not.toHaveBeenCalled();
  });

  it('takes a url given as an object or a request as readily as a string', async () => {
    const fakes = fetchers();
    const reach = new InstanceReach(production, fakes);
    await reach.fetchFor({ name: 'luno' })(new URL('https://luno.people.example/a'));
    await reach.fetchFor({ name: 'luno' })(new Request('https://luno.people.example/b'));
    expect(fakes.viaCaddy).toHaveBeenCalledTimes(2);
  });

  it('calls the instance\'s mesh address directly, without following redirects', async () => {
    const fakes = fetchers();
    const reach = new InstanceReach({ ...production, domain: undefined, ownCaddy: undefined }, fakes);
    const got = await reach.fetchFor({ name: 'luno', meshIp: '100.64.0.7' })('http://100.64.0.7:30320/api/auth/sign-in');
    expect(await got.json()).toEqual({ via: 'open' });
    expect(fakes.open).toHaveBeenCalledWith(new URL('http://100.64.0.7:30320/api/auth/sign-in'), { redirect: 'manual' });
    expect(fakes.public).not.toHaveBeenCalled();
  });

  it('calls anything it is not given a reason to refuse on a dev box or in a lab', async () => {
    const fakes = fetchers();
    const reach = new InstanceReach({ open: true }, fakes);
    const got = await reach.fetchFor({})('http://127.0.0.1:3001/api/auth/sign-in');
    expect(await got.json()).toEqual({ via: 'open' });
    expect(fakes.open).toHaveBeenCalledWith(new URL('http://127.0.0.1:3001/api/auth/sign-in'), { redirect: 'manual' });
  });

  it('calls a public address only through the check that refuses private ones', async () => {
    const fakes = fetchers();
    const reach = new InstanceReach({ open: false }, fakes);
    const got = await reach.fetchFor({ name: 'luno' })('https://example.org/api/auth/sign-in', { method: 'GET' });
    expect(await got.json()).toEqual({ via: 'public' });
    expect(fakes.public).toHaveBeenCalledWith(new URL('https://example.org/api/auth/sign-in'), { method: 'GET' });
  });
});

describe('the address an instance reports for itself', () => {
  it('takes its own mesh address or the address root gave it without asking anyone', async () => {
    const fakes = fetchers();
    const reach = new InstanceReach({ open: false, domain: 'people.example', ownCaddy: { host: '127.0.0.1', port: 443 } }, fakes);
    expect(await reach.reportedUrl('http://100.64.0.7:30320/x?y', { name: 'luno', meshIp: '100.64.0.7' })).toEqual({ ok: true, url: 'http://100.64.0.7:30320' });
    expect(await reach.reportedUrl('https://luno.people.example', { name: 'luno' })).toEqual({ ok: true, url: 'https://luno.people.example' });
    expect(fakes.publicProblem).not.toHaveBeenCalled();
  });

  it('takes any address on a dev box', async () => {
    const reach = new InstanceReach({ open: true }, fetchers());
    expect(await reach.reportedUrl('http://localhost:3001', {})).toEqual({ ok: true, url: 'http://localhost:3001' });
  });

  it('takes another address only when it resolves to public addresses', async () => {
    const fakes = mock<ReachFetchers>();
    fakes.publicProblem.calledWith('https://example.org').mockResolvedValue(undefined);
    fakes.publicProblem.calledWith('http://10.0.0.5').mockResolvedValue('10.0.0.5 is a private address');
    const reach = new InstanceReach({ open: false }, fakes);
    expect(await reach.reportedUrl('https://example.org/path', { name: 'luno' })).toEqual({ ok: true, url: 'https://example.org' });
    const refused = await reach.reportedUrl('http://10.0.0.5', { name: 'luno' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? '' : refused.error).toContain('10.0.0.5 is a private address');
  });

  it('refuses something that is not an origin', async () => {
    const reach = new InstanceReach({ open: true }, fetchers());
    expect(await reach.reportedUrl('not a url', {})).toMatchObject({ ok: false, error: containing('origin') });
    expect(await reach.reportedUrl('ftp://example.org', {})).toMatchObject({ ok: false });
  });
});

describe('reaching instances as the environment says', () => {
  it('is open on a dev box and refuses private addresses in production', async () => {
    const dev = instanceReachFrom({});
    expect(await dev.reportedUrl('http://127.0.0.1:3001', {})).toEqual({ ok: true, url: 'http://127.0.0.1:3001' });
    const production = instanceReachFrom({ NODE_ENV: 'production', INGRESS_DOMAIN: 'people.example' });
    expect(await production.reportedUrl('https://luno.people.example', { name: 'luno' })).toEqual({ ok: true, url: 'https://luno.people.example' });
  });
});

describe('the connection through root\'s own Caddy', () => {
  function transport() {
    const connectors: unknown[] = [];
    const connect = mockFn<(options: Record<string, unknown>, callback: () => void) => void>();
    const agents: { options: { connect: (options: Record<string, unknown>, callback: () => void) => void } }[] = [];
    class FakeAgent {
      constructor(readonly options: { connect: (options: Record<string, unknown>, callback: () => void) => void }) {
        agents.push(this);
      }
    }
    const fetched = mockFn<CaddyTransport['fetch']>();
    fetched.mockImplementation(async () => Response.json({ via: 'caddy' }) as never);
    const built = mockFn<CaddyTransport['buildConnector']>();
    built.mockImplementation(((options: unknown) => { connectors.push(options); return connect; }) as never);
    return { agents, connect, connectors, fetched, built, transport: { Agent: FakeAgent as unknown as typeof Agent, buildConnector: built, fetch: fetched } };
  }

  const to = { host: '127.0.0.1', port: 8443, servername: 'luno.people.example' };

  it('asks through one agent that dials Caddy while naming the instance for TLS', async () => {
    const rig = transport();
    const via = caddyFetch({ ca: 'CA-PEM' }, rig.transport);
    const got = await via(new URL('https://luno.people.example/a'), { method: 'POST' }, to);
    expect(await got.json()).toEqual({ via: 'caddy' });
    expect(rig.connectors).toEqual([{ ca: 'CA-PEM' }]);
    expect(rig.fetched).toHaveBeenCalledWith('https://luno.people.example/a', matches<{ method: string; dispatcher: unknown }>((init) => init.method === 'POST' && init.dispatcher === rig.agents[0]));
    const callback = () => undefined;
    rig.agents[0]!.options.connect({ hostname: 'luno.people.example', port: '443', protocol: 'https:' } as never, callback);
    expect(rig.connect).toHaveBeenCalledWith({ hostname: '127.0.0.1', port: '8443', servername: 'luno.people.example', protocol: 'https:' }, callback);
  });

  it('keeps an agent for each Caddy and name, and trusts the system\'s authorities when given none', async () => {
    const rig = transport();
    const via = caddyFetch({}, rig.transport);
    await via(new URL('https://luno.people.example/a'), undefined, to);
    await via(new URL('https://luno.people.example/b'), undefined, to);
    await via(new URL('https://other.people.example/b'), undefined, { ...to, servername: 'other.people.example' });
    expect(rig.agents).toHaveLength(2);
    expect(rig.connectors).toEqual([{}, {}]);
  });
});

