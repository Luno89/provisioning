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
  token: string;
  location: string;
  nonceCookie: string | undefined;
}

export const fetchSide = (base: string, cookie?: string): Side => async (path, init = {}) => {
  const sent = init.cookie ?? cookie;
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

export async function handOff(root: Side, target: Side, first = '/api/identity/go'): Promise<Handoff> {
  const go = await root(first);
  assert.equal(go.status, 302, `root did not hand the person over: ${go.status} ${go.body}`);
  const token = tokenIn(go.location);
  assert.ok(token, `root sent the person to ${go.location}`);
  const exchange = await target('/api/auth/handoff', { method: 'POST', body: { token } });
  if (!(exchange.status === 401 && /"restart":true/.test(exchange.body))) return { exchange, token, location: go.location, nonceCookie: undefined };

  const next = nextIn(go.location);
  const start = await target(`/api/auth/handoff/start${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  assert.equal(start.status, 302, `the sign-in did not start there: ${start.status} ${start.body}`);
  const nonceCookie = start.setCookies.map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?handoff_nonce=/.test(pair));
  assert.ok(nonceCookie, 'starting the sign-in set no nonce cookie');
  const back = new URL(start.location);
  assert.ok(back.searchParams.get('nonce'), `the sign-in started with no nonce: ${start.location}`);
  const bound = await root(`${back.pathname}${back.search}`);
  assert.equal(bound.status, 302, `root did not hand the person over with the nonce: ${bound.status} ${bound.body}`);
  const boundToken = tokenIn(bound.location);
  assert.ok(boundToken, `root sent the person to ${bound.location}`);
  return { exchange: await target('/api/auth/handoff', { method: 'POST', body: { token: boundToken }, cookie: nonceCookie }), token: boundToken, location: bound.location, nonceCookie };
}

export const sessionFrom = (setCookies: readonly string[]): string | undefined =>
  setCookies.map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?session=./.test(pair));
