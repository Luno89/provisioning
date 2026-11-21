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

export async function handOff(root: Side, target: Side, first = '/api/identity/go'): Promise<Handoff> {
  const go = await root(first);
  assert.equal(go.status, 302, `root did not send the person on: ${go.status} ${go.body}`);
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
  setCookies.map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?(session|koala_sid)=./.test(pair));

export const signedInLanding = (exchange: Hop): boolean => exchange.status === 200 || (exchange.status === 302 && exchange.location.startsWith('/#'));
