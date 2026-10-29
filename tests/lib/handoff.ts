import assert from 'node:assert/strict';

export interface Hop {
  status: number;
  location: string;
  setCookies: string[];
  body: string;
}

export type Side = (path: string, init?: { method?: string; body?: unknown; cookie?: string }) => Hop | Promise<Hop>;

export interface Handoff {
  exchange: Hop;
  location: string;
  callback?: string | undefined;
  startCookie?: string | undefined;
  token?: string | undefined;
  nonceCookie?: string | undefined;
}

export const fetchSide = (base: string, cookie?: string): Side => async (path, init = {}) => {
  const sent = [cookie, init.cookie].filter(Boolean).join('; ');
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(sent ? { Cookie: sent } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: response.status, location: response.headers.get('location') ?? '', setCookies: response.headers.getSetCookie(), body: await response.text() };
};

const tokenIn = (location: string): string => decodeURIComponent(/[?&]token=([^&]+)/.exec(location)?.[1] ?? '');
const nextIn = (location: string): string | undefined => {
  const next = /[?&]next=([^&]+)/.exec(location)?.[1];
  return next ? decodeURIComponent(next) : undefined;
};

type Jar = Map<string, string>;

const keep = (jar: Jar, setCookies: readonly string[]): void => {
  for (const line of setCookies) {
    const pair = line.split(';')[0]!;
    const at = pair.indexOf('=');
    const value = pair.slice(at + 1);
    if (!value || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(pair.slice(0, at));
    else jar.set(pair.slice(0, at), value);
  }
};

const sent = (jar: Jar): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

const pathOf = (url: URL): string => `${url.pathname}${url.search}`;

async function legacyHandOff(root: Side, target: Side, go: Hop): Promise<Handoff> {
  const token = tokenIn(go.location);
  const exchange = await target('/api/auth/handoff', { method: 'POST', body: { token } });
  if (!(exchange.status === 401 && /"restart":true/.test(exchange.body))) return { exchange, token, location: go.location };
  const next = nextIn(go.location);
  const start = await target(`/api/auth/handoff/start${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  assert.equal(start.status, 302, `the sign-in did not start there: ${start.status} ${start.body}`);
  const nonceCookie = start.setCookies.map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?handoff_nonce=/.test(pair));
  assert.ok(nonceCookie, 'starting the sign-in set no nonce cookie');
  const back = new URL(start.location);
  const bound = await root(pathOf(back));
  assert.equal(bound.status, 302, `root did not hand the person over with the nonce: ${bound.status} ${bound.body}`);
  const boundToken = tokenIn(bound.location);
  assert.ok(boundToken, `root sent the person to ${bound.location}`);
  return { exchange: await target('/api/auth/handoff', { method: 'POST', body: { token: boundToken }, cookie: nonceCookie }), token: boundToken, location: bound.location, nonceCookie };
}

export async function handOff(root: Side, target: Side, first = '/api/identity/go'): Promise<Handoff> {
  const go = await root(first);
  assert.equal(go.status, 302, `root did not send the person on: ${go.status} ${go.body}`);
  if (/\/#\/handoff\?token=/.test(go.location)) return legacyHandOff(root, target, go);

  return followSignIn(root, target, new URL(go.location), go.location);
}

export async function followSignIn(root: Side, target: Side, startAt: URL, location = startAt.href): Promise<Handoff> {
  const targetJar: Jar = new Map();
  const rootJar: Jar = new Map();
  const started = await target(pathOf(startAt));
  assert.equal(started.status, 302, `the sign-in did not start there: ${started.status} ${started.body}`);
  keep(targetJar, started.setCookies);
  const startCookie = sent(targetJar);
  let next = new URL(started.location);
  const rootOrigin = next.origin;
  for (let hops = 0; hops < 8; hops += 1) {
    if (next.origin === startAt.origin) {
      const exchange = await target(pathOf(next), { cookie: sent(targetJar) });
      return { exchange, location, callback: pathOf(next), startCookie };
    }
    assert.equal(next.origin, rootOrigin, `the sign-in went somewhere else: ${next.href}`);
    const hop = await root(pathOf(next), { cookie: sent(rootJar) });
    keep(rootJar, hop.setCookies);
    assert.ok(hop.status >= 300 && hop.status < 400 && hop.location, `root stopped the sign-in at ${next.pathname}: ${hop.status} ${hop.body.slice(0, 300)}`);
    next = new URL(hop.location, next);
  }
  assert.fail('the sign-in went round root without coming back');
}

export const sessionFrom = (setCookies: readonly string[]): string | undefined =>
  setCookies.map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?session=./.test(pair));

export const signedInLanding = (exchange: Hop): boolean => exchange.status === 200 || (exchange.status === 302 && exchange.location.startsWith('/#'));
