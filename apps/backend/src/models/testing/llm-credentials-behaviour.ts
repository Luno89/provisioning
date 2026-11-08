import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { decryptValue } from '../../platform/lib/crypto.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { ModelEndpointMetadata } from '../../platform/lib/types.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { CredentialService } from '../../infrastructure/index.js';
import { challengeOf, CONNECT_COOKIE, OPENROUTER_KEYS_URL } from '../lib/openrouter-connect.js';
import { llmCredentialsRouter, pricingOf } from '../routes/llm-credentials.js';

const DATA_KEY = 'test-data-key-0123456789abcdef0123456789abcdef';
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';
const MISTRAL_MODELS = 'https://api.mistral.ai/v1/models';
const AA_MODELS = 'https://artificialanalysis.ai/api/v2/data/llms/models';

const openRouterModels = [
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3', context_length: 131072, pricing: { prompt: '0', completion: '0' } },
  { id: 'anthropic/claude-sonnet-4', pricing: { prompt: '0.000003', completion: '0.000015' } },
];

const network = interceptHttp();

const cookiesOf = (headers: Record<string, unknown>): string[] => [headers['set-cookie']].flat().filter((line): line is string => typeof line === 'string');

let db: Database;
let credentials: MockProxy<Pick<CredentialService, 'resolveCredentials'>>;

const call = async (path: string, options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; cookie?: string; userId?: string; publicUrl?: string; withCredentials?: boolean } = {}) => {
  const routes = await routesInProcess({
    prefix: '/api/credentials',
    router: () => llmCredentialsRouter({
      db,
      dataKey: DATA_KEY,
      ...(options.withCredentials === false ? {} : { credentialService: credentials }),
      publicUrl: options.publicUrl ?? 'https://api.example.com',
      appUrl: 'https://app.example.com',
    }),
    user: { id: options.userId ?? PERSON.id, email: PERSON.email },
    db,
  });
  return routes.request(options.method ?? 'GET', `/api/credentials${path}`, { body: options.body, ...(options.cookie ? { headers: { cookie: options.cookie } } : {}) });
};

const mine = async (userId = PERSON.id) => (await db.models.getModelEndpoints()).filter((row) => row.ownerId === userId);
const endpoint = (fields: Partial<ModelEndpointMetadata> & { id: string }): ModelEndpointMetadata =>
  ({ ownerId: PERSON.id, name: 'x', baseUrl: 'https://openrouter.ai/api/v1', model: 'm', createdAt: 't', ...fields });
const openRouterListed = () => network.use(http.get(OPENROUTER_MODELS, () => HttpResponse.json({ data: openRouterModels })));

export function llmCredentialsBehaviour(make: () => Promise<Database>): void {
  beforeEach(async () => {
    db = await make();
    credentials = mock<Pick<CredentialService, 'resolveCredentials'>>();
    credentials.resolveCredentials.mockResolvedValue({ mode: 'none', env: {} });
  });

  describe('the gateways a person can connect', () => {
    it('lists each with how many of its models the person has and whether a key is stored', async () => {
      await db.models.saveModelEndpoint(endpoint({ id: 'a', name: 'OpenRouter · m1', apiKeyEnc: 'sealed' }));
      await db.models.saveModelEndpoint(endpoint({ id: 'b', name: 'OpenRouter · m2' }));
      await db.models.saveModelEndpoint(endpoint({ id: 'c', ownerId: 'someone', name: 'Groq · m', baseUrl: 'https://api.groq.com/openai/v1' }));
      const { data } = await call('/llm');
      const providers = (data as { providers: Array<{ provider: string; modelCount: number; hasKey: boolean; label: string }> }).providers;
      expect(providers.map((entry) => entry.provider)).toEqual(['openrouter', 'groq', 'together', 'mistral']);
      expect(providers[0]).toMatchObject({ label: 'OpenRouter', modelCount: 2, hasKey: true });
      expect(providers[1]).toMatchObject({ modelCount: 0, hasKey: false });
    });
  });

  describe('connecting a gateway with a key', () => {
    it('stores one endpoint per model with the key sealed, its window and its prices, replacing what was there', async () => {
      await db.models.saveModelEndpoint(endpoint({ id: 'old', name: 'OpenRouter · old', model: 'old' }));
      openRouterListed();
      const answer = await call('/llm', { method: 'POST', body: { provider: 'openrouter', apiKey: 'sk-key' } });
      expect(answer.status).toBe(200);
      const rows = await mine();
      expect(rows.map((row) => row.model).sort()).toEqual(['anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b-instruct:free']);
      expect(rows.every((row) => row.apiKeyEnc && decryptValue(row.apiKeyEnc, DATA_KEY) === 'sk-key')).toBe(true);
      expect(rows.find((row) => row.model === 'anthropic/claude-sonnet-4')?.pricing).toEqual({ promptPerMTok: 3, completionPerMTok: 15 });
      expect(rows.find((row) => row.model?.startsWith('meta-llama'))).toMatchObject({ contextTokens: 131072, name: 'OpenRouter · meta-llama/llama-3.3-70b-instruct:free' });
      expect((answer.data as { endpoints: unknown[] }).endpoints).toHaveLength(2);
    });

    it('leaves another person\'s endpoints for the same gateway alone', async () => {
      await db.models.saveModelEndpoint(endpoint({ id: 'theirs', ownerId: 'someone' }));
      openRouterListed();
      await call('/llm', { method: 'POST', body: { provider: 'openrouter' } });
      expect(await mine('someone')).toHaveLength(1);
    });

    it('asks for the key where the gateway lists its models only to those who have one', async () => {
      expect(await call('/llm', { method: 'POST', body: { provider: 'mistral' } })).toMatchObject({ status: 400, data: { error: 'API key is required for this provider' } });
      let authorization: string | null = null;
      network.use(http.get(MISTRAL_MODELS, ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json({ data: [{ id: 'mistral-small' }] });
      }));
      expect((await call('/llm', { method: 'POST', body: { provider: 'mistral', apiKey: 'mk' } })).status).toBe(200);
      expect(authorization).toBe('Bearer mk');
    });

    it('reads a gateway that lists its models as models', async () => {
      network.use(http.get(OPENROUTER_MODELS, () => HttpResponse.json({ models: [{ id: 'only', pricing: { prompt: 0.000001, completion: 'free' } }, { name: 'no id' }] })));
      await call('/llm', { method: 'POST', body: { provider: 'openrouter' } });
      const rows = await mine();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.pricing).toBeUndefined();
      expect(rows[0]?.apiKeyEnc).toBeUndefined();
    });

    it('says what the gateway answered when it refuses, and when it lists nothing', async () => {
      network.use(http.get(OPENROUTER_MODELS, () => new HttpResponse('nope'.repeat(100), { status: 503 })));
      const refused = await call('/llm', { method: 'POST', body: { provider: 'openrouter' } });
      expect(refused.status).toBe(400);
      expect((refused.data as { error: string }).error).toBe(`Provider returned 503: ${'nope'.repeat(100).slice(0, 200)}`);
      network.use(http.get(OPENROUTER_MODELS, () => HttpResponse.json({ data: [] })));
      expect(await call('/llm', { method: 'POST', body: { provider: 'openrouter' } })).toMatchObject({ status: 400, data: { error: 'No models returned from provider' } });
      expect(await mine()).toEqual([]);
    });

    it('says so when the gateway cannot be reached', async () => {
      network.use(http.get(OPENROUTER_MODELS, () => HttpResponse.error()));
      const answer = await call('/llm', { method: 'POST', body: { provider: 'openrouter' } });
      expect(answer.status).toBe(400);
      expect((answer.data as { error: string }).error).toMatch(/fetch failed|Failed to fetch|network/i);
    });

    it('refuses a request that names no provider or an unknown one', async () => {
      expect(await call('/llm', { method: 'POST', body: {} })).toMatchObject({ status: 400, data: { error: 'provider is required' } });
      expect(await call('/llm', { method: 'POST', body: { provider: 'acme' } })).toMatchObject({ status: 400, data: { error: 'Unknown provider: acme' } });
    });
  });

  describe('connecting a custom endpoint', () => {
    it('stores the one model at the address without its trailing slash, with the key sealed', async () => {
      const answer = await call('/llm', { method: 'POST', body: { provider: 'custom', baseUrl: 'https://models.example.com/v1/', model: 'qwen', apiKey: 'k' } });
      expect(answer.status).toBe(200);
      const [row] = await mine();
      expect(row).toMatchObject({ name: 'Custom · qwen', baseUrl: 'https://models.example.com/v1', model: 'qwen' });
      expect(decryptValue(row!.apiKeyEnc!, DATA_KEY)).toBe('k');
    });

    it('names a keyless endpoint by its model, and does not store the same one twice', async () => {
      const body = { provider: 'custom', baseUrl: 'https://models.example.com/v1', model: 'qwen' };
      await call('/llm', { method: 'POST', body });
      const again = await call('/llm', { method: 'POST', body });
      expect((await mine()).map((row) => row.name)).toEqual(['qwen']);
      expect((again.data as { endpoints: unknown[] }).endpoints).toHaveLength(1);
    });

    it('needs an address and a model', async () => {
      expect(await call('/llm', { method: 'POST', body: { provider: 'custom', model: 'qwen' } })).toMatchObject({ status: 400, data: { error: 'baseUrl is required for custom endpoints' } });
      expect(await call('/llm', { method: 'POST', body: { provider: 'custom', baseUrl: 'https://x.example.com' } })).toMatchObject({ status: 400, data: { error: 'model is required for custom endpoints' } });
    });
  });

  describe('refreshing a gateway\'s models', () => {
    beforeEach(async () => {
      await db.models.saveModelEndpoint(endpoint({ id: 'llama', name: 'OpenRouter · meta-llama/llama-3.3-70b-instruct:free', model: 'meta-llama/llama-3.3-70b-instruct:free', apiKeyEnc: 'sealed' }));
      await db.models.saveModelEndpoint(endpoint({ id: 'retired', name: 'OpenRouter · retired', model: 'retired' }));
      openRouterListed();
    });

    it('updates the window and prices on the rows already stored, keeping their ids and keys, and counts what no longer matches', async () => {
      const answer = await call('/llm/openrouter/refresh', { method: 'POST' });
      expect(answer.data).toEqual({ updated: 1, unmatched: 1, total: 2, scored: 0, scoresAvailable: 0 });
      expect((await mine()).find((row) => row.id === 'llama')).toMatchObject({ contextTokens: 131072, pricing: { promptPerMTok: 0, completionPerMTok: 0 }, apiKeyEnc: 'sealed' });
    });

    it('adds intelligence scores when the person has a key for Artificial Analysis', async () => {
      credentials.resolveCredentials.mockResolvedValue({ mode: 'user', env: { ARTIFICIALANALYSIS_API_KEY: 'aa' } } as never);
      let sent: string | null = null;
      network.use(http.get(AA_MODELS, ({ request }) => {
        sent = request.headers.get('x-api-key');
        return HttpResponse.json({ data: [{ id: 'x', slug: 'llama-3-3-instruct-70b', name: 'Llama 3.3 Instruct 70B', evaluations: { artificial_analysis_intelligence_index: 14 } }] });
      }));
      const answer = await call('/llm/openrouter/refresh', { method: 'POST' });
      expect(sent).toBe('aa');
      expect((answer.data as { scoresAvailable: number }).scoresAvailable).toBeGreaterThan(0);
      expect(credentials.resolveCredentials).toHaveBeenCalledWith(PERSON.id, 'artificialanalysis');
    });

    it('still refreshes when the scores cannot be had', async () => {
      credentials.resolveCredentials.mockResolvedValue({ mode: 'user', env: { ARTIFICIALANALYSIS_API_KEY: 'aa' } } as never);
      network.use(http.get(AA_MODELS, () => new HttpResponse(null, { status: 500 })));
      expect((await call('/llm/openrouter/refresh', { method: 'POST' })).data).toMatchObject({ updated: 1, scoresAvailable: 0 });
      credentials.resolveCredentials.mockRejectedValue(new Error('no credentials'));
      expect((await call('/llm/openrouter/refresh', { method: 'POST' })).data).toMatchObject({ updated: 1, scoresAvailable: 0 });
      expect((await call('/llm/openrouter/refresh', { method: 'POST', withCredentials: false })).data).toMatchObject({ updated: 1, scoresAvailable: 0 });
    });

    it('refuses a gateway the person has not set up, an unknown one, and a list that cannot be read', async () => {
      expect(await call('/llm/groq/refresh', { method: 'POST' })).toMatchObject({ status: 404, data: { error: 'Groq is not set up on this account' } });
      expect(await call('/llm/acme/refresh', { method: 'POST' })).toMatchObject({ status: 400, data: { error: 'Unknown provider: acme' } });
      network.use(http.get(OPENROUTER_MODELS, () => new HttpResponse('down', { status: 502 })));
      expect(await call('/llm/openrouter/refresh', { method: 'POST' })).toMatchObject({ status: 400, data: { error: 'Provider returned 502: down' } });
    });
  });

  describe('removing a gateway', () => {
    it('removes the person\'s endpoints for it and no one else\'s', async () => {
      await db.models.saveModelEndpoint(endpoint({ id: 'a' }));
      await db.models.saveModelEndpoint(endpoint({ id: 'b', baseUrl: 'https://api.groq.com/openai/v1' }));
      await db.models.saveModelEndpoint(endpoint({ id: 'c', ownerId: 'someone' }));
      expect(await call('/llm/openrouter', { method: 'DELETE' })).toMatchObject({ status: 200, data: { removed: 1 } });
      expect((await db.models.getModelEndpoints()).map((row) => row.id).sort()).toEqual(['b', 'c']);
    });

    it('removes every custom endpoint of the person with custom', async () => {
      await db.models.saveModelEndpoint(endpoint({ id: 'a', baseUrl: 'https://x.example.com/v1' }));
      await db.models.saveModelEndpoint(endpoint({ id: 'b', baseUrl: 'https://y.example.com/v1' }));
      expect(await call('/llm/custom', { method: 'DELETE' })).toMatchObject({ data: { removed: 2 } });
    });

    it('refuses an unknown provider', async () => {
      expect(await call('/llm/acme', { method: 'DELETE' })).toMatchObject({ status: 400, data: { error: 'Unknown provider: acme' } });
    });
  });

  describe('connecting OpenRouter with the person\'s own account', () => {
    const started = async () => {
      const answer = await call('/llm/openrouter/connect');
      const setCookie = cookiesOf(answer.headers).find((line) => line.startsWith(`${CONNECT_COOKIE}=`))!;
      const location = new URL(answer.headers.location as string);
      return { answer, setCookie, cookie: setCookie.split(';')[0]!, location };
    };
    const stateOf = (location: URL) => location.searchParams.get('state');
    const failure = (answer: { headers: Record<string, unknown> }) => decodeURIComponent(String(answer.headers.location));

    it('sends the person to OpenRouter with a challenge and a state, keeping the verifier only in a sealed cookie', async () => {
      const { answer, setCookie, location } = await started();
      expect(answer.status).toBe(302);
      expect(location.origin + location.pathname).toBe('https://openrouter.ai/auth');
      expect(location.searchParams.get('callback_url')).toBe('https://api.example.com/api/credentials/llm/openrouter/callback');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.get('key_label')).toBe('Koala');
      expect(stateOf(location)).toBeTruthy();
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/Path=\/api\/credentials\/llm\/openrouter/);
      expect(setCookie).toMatch(/Secure/);
      const sealed = setCookie.split(';')[0]!.slice(CONNECT_COOKIE.length + 1);
      const pending = JSON.parse(decryptValue(Buffer.from(sealed, 'base64url').toString('utf8'), DATA_KEY)) as { userId: string; verifier: string };
      expect(pending.userId).toBe(PERSON.id);
      expect(challengeOf(pending.verifier)).toBe(location.searchParams.get('code_challenge'));
      expect(location.toString()).not.toContain(pending.verifier);
    });

    it('does not mark the cookie secure where the server is plain http', async () => {
      const answer = await call('/llm/openrouter/connect', { publicUrl: 'http://localhost:3001' });
      expect(cookiesOf(answer.headers)[0]).not.toMatch(/Secure/);
      expect(new URL(String(answer.headers.location)).searchParams.get('callback_url')).toBe('http://localhost:3001/api/credentials/llm/openrouter/callback');
    });

    it('trades the code for a key with the verifier, stores the key sealed on every OpenRouter model, and returns to Models', async () => {
      const { cookie, location } = await started();
      let exchange: { code: string; code_challenge_method: string; code_verifier: string } | undefined;
      const takeExchange = async ({ request }: { request: Request }) => {
        exchange = await request.json() as typeof exchange;
        return HttpResponse.json({ key: 'sk-or-v1-from-oauth' });
      };
      network.use(http.post(OPENROUTER_KEYS_URL, takeExchange));
      openRouterListed();
      const back = await call(`/llm/openrouter/callback?code=the-code&state=${stateOf(location)}`, { cookie });
      expect(back.status).toBe(302);
      expect(back.headers.location).toBe('https://app.example.com/?openrouterConnected=1#/studio/models');
      expect(exchange).toMatchObject({ code: 'the-code', code_challenge_method: 'S256' });
      expect(challengeOf(exchange!.code_verifier)).toBe(location.searchParams.get('code_challenge'));
      const rows = await mine();
      expect(rows.map((row) => row.model).sort()).toEqual(['anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b-instruct:free']);
      expect(rows.every((row) => row.apiKeyEnc && decryptValue(row.apiKeyEnc, DATA_KEY) === 'sk-or-v1-from-oauth')).toBe(true);
      expect(cookiesOf(back.headers).join(';')).toMatch(new RegExp(`${CONNECT_COOKIE}=;`));
    });

    it('refuses a callback whose state is not the one it started, without asking OpenRouter', async () => {
      const { cookie } = await started();
      const back = await call('/llm/openrouter/callback?code=c&state=someone-elses', { cookie });
      expect(failure(back)).toContain('does not match the one Koala started');
      expect(await mine()).toEqual([]);
    });

    it('refuses a callback it never started, and one started by someone else on this browser', async () => {
      const { cookie, location } = await started();
      const state = stateOf(location);
      expect(failure(await call(`/llm/openrouter/callback?code=c&state=${state}`))).toContain('not started from Koala');
      expect(failure(await call(`/llm/openrouter/callback?code=c&state=${state}`, { cookie, userId: 'someone-else' }))).toContain('started by someone else');
    });

    it('says so in plain words when the person turned it down or OpenRouter refuses the code', async () => {
      const { cookie, location } = await started();
      expect(failure(await call('/llm/openrouter/callback?error=access_denied', { cookie }))).toContain('did not give Koala a key');
      network.use(http.post(OPENROUTER_KEYS_URL, () => HttpResponse.json({ error: 'Authorization code expired' }, { status: 403 })));
      expect(failure(await call(`/llm/openrouter/callback?code=c&state=${stateOf(location)}`, { cookie }))).toContain('longer than its ten minutes');
      const again = await started();
      network.use(http.post(OPENROUTER_KEYS_URL, () => HttpResponse.json({ error: { message: 'Invalid code', code: 400 } }, { status: 400 })));
      expect(failure(await call(`/llm/openrouter/callback?code=c&state=${stateOf(again.location)}`, { cookie: again.cookie }))).toContain('did not accept the connection');
      expect(await mine()).toEqual([]);
    });

    it('says so when OpenRouter answers without a key, with something that is not JSON, or cannot be reached', async () => {
      const first = await started();
      network.use(http.post(OPENROUTER_KEYS_URL, () => HttpResponse.json({ nothing: true })));
      expect(failure(await call(`/llm/openrouter/callback?code=c&state=${stateOf(first.location)}`, { cookie: first.cookie }))).toContain('OpenRouter answered without a key. Nothing was connected.');
      const second = await started();
      network.use(http.post(OPENROUTER_KEYS_URL, () => new HttpResponse('<html>', { status: 200 })));
      expect(failure(await call(`/llm/openrouter/callback?code=c&state=${stateOf(second.location)}`, { cookie: second.cookie }))).toContain('OpenRouter answered without a key');
      const third = await started();
      network.use(http.post(OPENROUTER_KEYS_URL, () => HttpResponse.error()));
      expect(failure(await call(`/llm/openrouter/callback?code=c&state=${stateOf(third.location)}`, { cookie: third.cookie }))).toContain('Could not reach OpenRouter');
    });

    it('says why the models could not be stored once the key was had', async () => {
      const { cookie, location } = await started();
      network.use(
        http.post(OPENROUTER_KEYS_URL, () => HttpResponse.json({ key: 'sk-or-v1-k' })),
        http.get(OPENROUTER_MODELS, () => new HttpResponse('down', { status: 502 })),
      );
      expect(failure(await call(`/llm/openrouter/callback?code=c&state=${stateOf(location)}`, { cookie }))).toContain('Provider returned 502: down');
    });
  });

  describe('what a gateway charges', () => {
    it('turns per-token prices into dollars per million tokens', () => {
      expect(pricingOf({ id: 'm', pricing: { prompt: '0.000003', completion: '0.000015' } })).toEqual({ promptPerMTok: 3, completionPerMTok: 15 });
      expect(pricingOf({ id: 'm', pricing: { prompt: '0', completion: '0' } })).toEqual({ promptPerMTok: 0, completionPerMTok: 0 });
    });

    it('shows nothing for a price it cannot say, rather than free', () => {
      expect(pricingOf({ id: 'm' })).toBeUndefined();
      expect(pricingOf({ id: 'm', pricing: { prompt: '0.000001' } })).toBeUndefined();
      expect(pricingOf({ id: 'm', pricing: { prompt: '-1', completion: '-1' } })).toBeUndefined();
      expect(pricingOf({ id: 'm', pricing: { prompt: 'varies', completion: '0.1' } })).toBeUndefined();
    });
  });
}
