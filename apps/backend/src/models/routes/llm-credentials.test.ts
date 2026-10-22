import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { llmCredentialsRouter } from './llm-credentials.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { challengeOf, CONNECT_COOKIE, OPENROUTER_KEYS_URL } from '../lib/openrouter-connect.js';
import { decryptValue } from '../../platform/lib/crypto.js';

const DATA_KEY = 'test-data-key-0123456789abcdef0123456789abcdef';
let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.unstubAllGlobals(); });

const mount = async () => {
  h = await mountRouter({
    prefix: '/api/credentials',
    router: (db) => llmCredentialsRouter({ db, dataKey: DATA_KEY, publicUrl: 'https://api.example.com', appUrl: 'https://app.example.com' }),
  });
  return h;
};

const get = (url: string, cookie?: string) => axios.get(url, { maxRedirects: 0, validateStatus: () => true, ...(cookie ? { headers: { Cookie: cookie } } : {}) });

const openRouter = (exchange: { status: number; body: string }) => {
  const realFetch = globalThis.fetch;
  const seen: { url: string; body?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === OPENROUTER_KEYS_URL) {
      seen.push({ url, body: String(init?.body) });
      return new Response(exchange.body, { status: exchange.status });
    }
    if (url === 'https://openrouter.ai/api/v1/models') {
      seen.push({ url });
      return Response.json({ data: [{ id: 'meta-llama/llama-3.3-70b-instruct:free', context_length: 131072, pricing: { prompt: '0', completion: '0' } }, { id: 'anthropic/claude-sonnet-4', pricing: { prompt: '0.000003', completion: '0.000015' } }] });
    }
    return realFetch(input, init);
  }));
  return seen;
};

const started = async (harness: Harness) => {
  const answer = await get(harness.url('/api/credentials/llm/openrouter/connect'));
  const setCookie = (answer.headers['set-cookie'] ?? []).find((line: string) => line.startsWith(`${CONNECT_COOKIE}=`))!;
  const location = new URL(answer.headers.location as string);
  return { answer, setCookie, cookie: setCookie.split(';')[0]!, location };
};

describe('connecting OpenRouter with the person\'s own account', () => {
  it('sends the person to OpenRouter with a challenge and a state, keeping the verifier only in a sealed cookie', async () => {
    const harness = await mount();
    const { answer, setCookie, location } = await started(harness);
    expect(answer.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://openrouter.ai/auth');
    expect(location.searchParams.get('callback_url')).toBe('https://api.example.com/api/credentials/llm/openrouter/callback');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('key_label')).toBe('Koala');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Path=\/api\/credentials\/llm\/openrouter/);
    expect(setCookie).toMatch(/Secure/);
    const sealed = setCookie.split(';')[0]!.slice(CONNECT_COOKIE.length + 1);
    const pending = JSON.parse(decryptValue(Buffer.from(sealed, 'base64url').toString('utf8'), DATA_KEY));
    expect(pending.userId).toBe(TEST_USER.id);
    expect(challengeOf(pending.verifier)).toBe(location.searchParams.get('code_challenge'));
    expect(location.toString()).not.toContain(pending.verifier);
  });

  it('trades the code for a key with the verifier, stores the key encrypted on every OpenRouter model, and returns to Models', async () => {
    const harness = await mount();
    const { cookie, location } = await started(harness);
    const seen = openRouter({ status: 200, body: JSON.stringify({ key: 'sk-or-v1-from-oauth' }) });
    const back = await get(harness.url(`/api/credentials/llm/openrouter/callback?code=the-code&state=${location.searchParams.get('state')}`), cookie);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe('https://app.example.com/?openrouterConnected=1#/studio/models');
    const exchange = JSON.parse(seen.find((call) => call.url === OPENROUTER_KEYS_URL)!.body!);
    expect(exchange.code).toBe('the-code');
    expect(exchange.code_challenge_method).toBe('S256');
    expect(challengeOf(exchange.code_verifier)).toBe(location.searchParams.get('code_challenge'));
    const rows = (await harness.db.models.getModelEndpoints()).filter((row) => row.ownerId === TEST_USER.id);
    expect(rows.map((row) => row.model).sort()).toEqual(['anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b-instruct:free']);
    expect(rows.every((row) => row.apiKeyEnc && decryptValue(row.apiKeyEnc, DATA_KEY) === 'sk-or-v1-from-oauth')).toBe(true);
    expect(back.headers['set-cookie']?.join(';')).toMatch(new RegExp(`${CONNECT_COOKIE}=;`));
  });

  it('refuses a callback whose state is not the one it started, without asking OpenRouter', async () => {
    const harness = await mount();
    const { cookie } = await started(harness);
    const seen = openRouter({ status: 200, body: JSON.stringify({ key: 'sk-or-v1-x' }) });
    const back = await get(harness.url('/api/credentials/llm/openrouter/callback?code=c&state=someone-elses'), cookie);
    expect(decodeURIComponent(back.headers.location as string)).toContain('does not match the one Koala started');
    expect(seen).toEqual([]);
    expect(await harness.db.models.getModelEndpoints()).toEqual([]);
  });

  it('refuses a callback it never started, and one started by someone else on this browser', async () => {
    const harness = await mount();
    const { cookie, location } = await started(harness);
    const state = location.searchParams.get('state');
    expect(decodeURIComponent((await get(harness.url(`/api/credentials/llm/openrouter/callback?code=c&state=${state}`))).headers.location as string)).toContain('not started from Koala');
    harness.setUser({ ...TEST_USER, id: 'someone-else' });
    expect(decodeURIComponent((await get(harness.url(`/api/credentials/llm/openrouter/callback?code=c&state=${state}`), cookie)).headers.location as string)).toContain('started by someone else');
  });

  it('says so in plain words when the person turned it down or OpenRouter refuses the code', async () => {
    const harness = await mount();
    const { cookie, location } = await started(harness);
    expect(decodeURIComponent((await get(harness.url('/api/credentials/llm/openrouter/callback?error=access_denied'), cookie)).headers.location as string)).toContain('did not give Koala a key');
    openRouter({ status: 403, body: '{"error":"Authorization code expired"}' });
    const back = await get(harness.url(`/api/credentials/llm/openrouter/callback?code=c&state=${location.searchParams.get('state')}`), cookie);
    expect(decodeURIComponent(back.headers.location as string)).toContain('longer than its ten minutes');
    const again = await started(harness);
    openRouter({ status: 400, body: '{"error":{"message":"Invalid code","code":400}}' });
    const unknown = await get(harness.url(`/api/credentials/llm/openrouter/callback?code=c&state=${again.location.searchParams.get('state')}`), again.cookie);
    expect(decodeURIComponent(unknown.headers.location as string)).toContain('did not accept the connection');
    expect(await harness.db.models.getModelEndpoints()).toEqual([]);
  });
});
