import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startThreeRoles, type ThreeRoles } from '../platform/testing/three-roles.js';

interface Provider { provider: string; modelCount: number; hasKey: boolean }
interface Asked { method: string; path: string; body: string }

let roles: ThreeRoles;
let openRouter: Server;
let openRouterUrl = '';
const asked: Asked[] = [];

async function standInOpenRouter(): Promise<void> {
  openRouter = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://stand-in').pathname;
      asked.push({ method: req.method ?? '', path, body: Buffer.concat(chunks).toString('utf8') });
      if (req.method === 'GET' && path === '/auth') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Sign in to OpenRouter</body></html>');
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/auth/keys') {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid code', code: 400 } }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => openRouter.listen(0, '127.0.0.1', done));
  openRouterUrl = `http://127.0.0.1:${(openRouter.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  await standInOpenRouter();
  roles = await startThreeRoles('openrouter', { extra: { OPENROUTER_URL: openRouterUrl } });
}, 240_000);

afterAll(async () => {
  await roles?.close();
  await new Promise<void>((done) => (openRouter ? openRouter.close(() => done()) : done()));
});

describe('Connect OpenRouter on an instance signed in through root', () => {
  it('sends the person to OpenRouter\'s sign-in with a challenge and a state, refuses a state Koala did not make before asking OpenRouter, tells OpenRouter\'s refusal in plain words, and changes nothing', async () => {
    const instanceUrl = roles.instance.url;
    const session = await roles.ownerOnInstance();
    const openRouterNow = async (): Promise<Provider | undefined> => {
      const answer = await fetch(`${instanceUrl}/api/credentials/llm`, { headers: { Cookie: session } });
      expect(answer.status).toBe(200);
      return ((await answer.json()) as { providers: Provider[] }).providers.find((one) => one.provider === 'openrouter');
    };
    const before = await openRouterNow();
    expect(before).toBeDefined();

    const connect = await fetch(`${instanceUrl}/api/credentials/llm/openrouter/connect`, { redirect: 'manual', headers: { Cookie: session } });
    expect(connect.status, await connect.clone().text()).toBe(302);
    const auth = new URL(connect.headers.get('location')!);
    expect(`${auth.origin}${auth.pathname}`).toBe(`${openRouterUrl}/auth`);
    expect(auth.searchParams.get('callback_url')).toBe(`${instanceUrl}/api/credentials/llm/openrouter/callback`);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('code_challenge')).toBeTruthy();
    const state = auth.searchParams.get('state')!;
    expect(state).toBeTruthy();
    const pending = connect.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('openrouter_connect='));
    expect(pending, 'no sealed connection cookie').toBeTruthy();
    const page = await fetch(auth, { redirect: 'follow' });
    expect(page.status).toBe(200);

    const both = `${session}; ${pending}`;
    const back = async (query: string): Promise<URLSearchParams> => {
      const answer = await fetch(`${instanceUrl}/api/credentials/llm/openrouter/callback?${query}`, { redirect: 'manual', headers: { Cookie: both } });
      expect(answer.status, await answer.clone().text()).toBe(302);
      const where = new URL(answer.headers.get('location')!);
      expect(where.hash).toBe('#/studio/models');
      return where.searchParams;
    };

    const exchanges = () => asked.filter((one) => one.path === '/api/v1/auth/keys');
    expect((await back('code=made-up&state=not-it')).get('openrouterError') ?? '').toMatch(/does not match/);
    expect(exchanges()).toEqual([]);

    const code = `made-up-${Date.now()}`;
    const refused = (await back(`code=${code}&state=${encodeURIComponent(state)}`)).get('openrouterError') ?? '';
    expect(refused).toMatch(/did not accept the connection/);
    expect(exchanges()).toHaveLength(1);
    const exchange = JSON.parse(exchanges()[0]!.body) as { code: string; code_verifier: string; code_challenge_method: string };
    expect(exchange).toMatchObject({ code, code_challenge_method: 'S256' });
    expect(exchange.code_verifier).toBeTruthy();

    expect(await openRouterNow()).toEqual(before);
  });
}, 300_000);
