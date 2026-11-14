import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { matches, mock, type MockProxy } from 'vitest-mock-extended';
import type { MachineChoice } from '@koala/agent-engine/procedure';
import type { Database } from '../../platform/lib/db-interface.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { CredentialService } from '../../infrastructure/index.js';
import type { MachineService } from '../../machines/index.js';
import { modelsRouter, type ModelsRouterDeps } from '../routes/models.js';

const hf = interceptHttp();

type Machines = Pick<MachineService, 'choiceProblem'>;

let db: Database;
let listed: Array<{ id: string; name: string; chatProblem?: string }>;
let credentials: MockProxy<Pick<CredentialService, 'resolveCredentials'>>;
let machines: MockProxy<Machines>;
let rateLimits: Mock<ModelsRouterDeps['rateLimits']>;

const deps = (extra: Partial<ModelsRouterDeps> = {}): ModelsRouterDeps => ({
  modelService: { list: async () => listed },
  db,
  credentialService: credentials,
  rateLimits,
  machines,
  ...extra,
});

const call = async (path: string, method: 'GET' | 'PUT' = 'GET', body?: unknown, extra: Partial<ModelsRouterDeps> = {}) => {
  const routes = await routesInProcess({ prefix: '/api/models', router: () => modelsRouter(deps(extra)), user: PERSON, db });
  return routes.request(method, `/api/models${path}`, { body });
};

const saveAccount = (fields: Partial<UserMetadata> = {}) => db.accounts.saveUser({ id: PERSON.id, email: PERSON.email, ...fields } as UserMetadata);
const account = async () => db.accounts.getUserById(PERSON.id);

export function modelsRoutesBehaviour(make: () => Promise<Database>): void {
  beforeEach(async () => {
    db = await make();
    listed = [{ id: 'tabby-qwen', name: 'Qwen on TabbyAPI' }];
    credentials = mock<Pick<CredentialService, 'resolveCredentials'>>();
    credentials.resolveCredentials.mockResolvedValue({ mode: 'none', env: {} });
    machines = mock<Machines>();
    rateLimits = vi.fn<ModelsRouterDeps['rateLimits']>(() => []);
    hf.resetHandlers();
  });

  describe('model traffic', () => {
    it('shows the person the traffic of their own models', async () => {
      const bucket = { key: 'tabby', label: 'Tabby', inFlight: 1, queued: 0, totalRequests: 5, total429: 0, totalErrors: 0 };
      rateLimits.mockReturnValue([bucket]);
      expect(await call('/rate-limits')).toMatchObject({ status: 200, data: { buckets: [bucket] } });
      expect(rateLimits).toHaveBeenCalledWith(PERSON.id);
    });
  });

  describe('the models a person has', () => {
    it('lists them', async () => {
      expect(await call('/')).toMatchObject({ status: 200, data: [{ id: 'tabby-qwen' }] });
    });

    it('says why they cannot be listed', async () => {
      const answer = await call('/', 'GET', undefined, { modelService: { list: async () => { throw new Error('store is gone'); } } });
      expect(answer).toMatchObject({ status: 500, data: { error: 'store is gone' } });
    });
  });

  describe('the account default', () => {
    it('takes a model the person has, and shows it with the override', async () => {
      await saveAccount();
      expect(await call('/default', 'PUT', { modelId: 'tabby-qwen' })).toMatchObject({ status: 200, data: { success: true, defaultModelId: 'tabby-qwen' } });
      expect(await call('/default')).toMatchObject({ data: { defaultModelId: 'tabby-qwen', globalModelOverride: false } });
    });

    it('is cleared by null', async () => {
      await saveAccount({ defaultModelId: 'tabby-qwen' });
      expect(await call('/default', 'PUT', { modelId: null })).toMatchObject({ status: 200, data: { success: true, defaultModelId: null } });
      expect((await account())?.defaultModelId).toBeUndefined();
      expect(await call('/default')).toMatchObject({ data: { defaultModelId: null } });
    });

    it('refuses a model the person does not have, and one that is not a string', async () => {
      await saveAccount();
      expect(await call('/default', 'PUT', { modelId: 'nothing' })).toMatchObject({ status: 404, data: { error: 'Model not found' } });
      expect(await call('/default', 'PUT', { modelId: 7 })).toMatchObject({ status: 400, data: { error: 'modelId must be a string, or null to clear' } });
      expect((await account())?.defaultModelId).toBeUndefined();
    });

    it('refuses a model that cannot run Koala\'s chats, saying why, and keeps the default it had', async () => {
      await saveAccount({ defaultModelId: 'tabby-qwen' });
      listed = [{ id: 'tabby-qwen', name: 'Qwen on TabbyAPI' }, { id: 'vllm-1', name: 'Qwen', chatProblem: 'It is served without tool calling, which every Koala chat uses: turn tool calling on in its settings.' }];
      expect(await call('/default', 'PUT', { modelId: 'vllm-1' })).toMatchObject({ status: 400, data: { error: 'Qwen cannot run Koala\'s chats. It is served without tool calling, which every Koala chat uses: turn tool calling on in its settings.' } });
      expect((await account())?.defaultModelId).toBe('tabby-qwen');
    });

    it('answers 404 for a person with no account record', async () => {
      expect(await call('/default', 'PUT', { modelId: 'tabby-qwen' })).toMatchObject({ status: 404, data: { error: 'User not found' } });
    });

    it('takes an agent on one of the person\'s machines, and refuses one that cannot answer', async () => {
      await saveAccount();
      machines.choiceProblem.calledWith(PERSON.id, matches<MachineChoice>((choice) => choice.deviceId === 'gone')).mockResolvedValue('that machine is not one of yours any more');
      machines.choiceProblem.calledWith(PERSON.id, matches<MachineChoice>((choice) => choice.deviceId === 'd1')).mockResolvedValue(undefined);

      expect(await call('/default', 'PUT', { modelId: 'machine:d1:claude-code' })).toMatchObject({ status: 200, data: { defaultModelId: 'machine:d1:claude-code' } });
      expect(await call('/default', 'PUT', { modelId: 'machine:gone:claude-code' })).toMatchObject({ status: 400, data: { error: 'that machine is not one of yours any more' } });
      expect((await account())?.defaultModelId).toBe('machine:d1:claude-code');
    });

    it('refuses a machine where the server cannot reach people\'s machines', async () => {
      await saveAccount();
      expect(await call('/default', 'PUT', { modelId: 'machine:d1:claude-code' }, { machines: undefined })).toMatchObject({ status: 400, data: { error: 'this server cannot reach people\'s machines' } });
    });

    it('turns the override on and off', async () => {
      await saveAccount();
      expect(await call('/default/override', 'PUT', { override: true })).toMatchObject({ status: 200, data: { success: true, globalModelOverride: true } });
      expect(await call('/default')).toMatchObject({ data: { globalModelOverride: true } });
      expect(await call('/default/override', 'PUT', { override: false })).toMatchObject({ data: { globalModelOverride: false } });
      expect((await account())?.globalModelOverride).toBe(false);
    });

    it('refuses an override that is not true or false, and one for a person with no account', async () => {
      expect(await call('/default/override', 'PUT', { override: 'yes' })).toMatchObject({ status: 400, data: { error: 'override must be true or false' } });
      expect(await call('/default/override', 'PUT', { override: true })).toMatchObject({ status: 404, data: { error: 'User not found' } });
    });

    it('shows no default for a person with no account record', async () => {
      expect(await call('/default')).toMatchObject({ status: 200, data: { defaultModelId: null, globalModelOverride: false } });
    });
  });

  describe('the model that reads documents', () => {
    it('takes a model the person has, shows it and clears it', async () => {
      await saveAccount();
      expect(await call('/extractor', 'PUT', { modelId: 'tabby-qwen' })).toMatchObject({ status: 200, data: { success: true, extractionModelId: 'tabby-qwen' } });
      expect(await call('/extractor')).toMatchObject({ data: { extractionModelId: 'tabby-qwen' } });
      expect(await call('/extractor', 'PUT', { modelId: null })).toMatchObject({ data: { extractionModelId: null } });
      expect((await account())?.extractionModelId).toBeUndefined();
    });

    it('refuses a model the person does not have, one that is not a string, and a person with no account', async () => {
      expect(await call('/extractor', 'PUT', { modelId: 'nothing' })).toMatchObject({ status: 404, data: { error: 'Model not found' } });
      expect(await call('/extractor', 'PUT', { modelId: 4 })).toMatchObject({ status: 400 });
      expect(await call('/extractor', 'PUT', { modelId: 'tabby-qwen' })).toMatchObject({ status: 404, data: { error: 'User not found' } });
      expect(await call('/extractor')).toMatchObject({ data: { extractionModelId: null } });
    });

    it('says why it could not be set', async () => {
      const answer = await call('/extractor', 'PUT', { modelId: 'x' }, { modelService: { list: async () => { throw new Error('store is gone'); } } });
      expect(answer).toMatchObject({ status: 500, data: { error: 'store is gone' } });
    });
  });

  describe('looking up models on Hugging Face', () => {
    const tree = [{ type: 'file', path: 'a.safetensors', size: 100 }, { type: 'file', path: 'b.safetensors', size: 300 }, { type: 'directory', path: 'sub' }];

    it('sizes a model by its files, with the person\'s token', async () => {
      credentials.resolveCredentials.mockResolvedValue({ mode: 'user', env: { HF_TOKEN: 'hf_token' } } as never);
      let authorization: string | null = null;
      hf.use(http.get('https://huggingface.co/api/models/org/model/tree/main', ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json(tree);
      }));
      expect(await call('/hf-size?repo=org/model')).toMatchObject({ status: 200, data: { totalBytes: 400, fileCount: 2 } });
      expect(authorization).toBe('Bearer hf_token');
      expect(credentials.resolveCredentials).toHaveBeenCalledWith(PERSON.id, 'huggingface');
    });

    it('estimates the cache and weights each card holds for the sequence length and cards asked', async () => {
      hf.use(
        http.get('https://huggingface.co/api/models/org/model/tree/dev', () => HttpResponse.json(tree)),
        http.get('https://huggingface.co/org/model/raw/dev/config.json', () => HttpResponse.json({ num_hidden_layers: 2, hidden_size: 64, num_attention_heads: 1, num_key_value_heads: 1, head_dim: 64 })),
      );
      const answer = await call('/hf-size?repo=org/model&revision=dev&maxSeqLen=1000&gpuCount=2&cacheMode=Q8');
      expect(answer.data).toMatchObject({ totalBytes: 400, fileCount: 2, kvCacheBytesPerGpu: 2 * 1 * 64 * 1 * 2 * 1000 / 2, weightBytesPerGpu: 200 });
    });

    it('gives the size without an estimate when the config cannot be read', async () => {
      hf.use(
        http.get('https://huggingface.co/api/models/org/model/tree/main', () => HttpResponse.json(tree)),
        http.get('https://huggingface.co/org/model/raw/main/config.json', () => new HttpResponse(null, { status: 404 })),
      );
      const answer = await call('/hf-size?repo=org/model&maxSeqLen=1000');
      expect(answer.data).toEqual({ totalBytes: 400, fileCount: 2 });
    });

    it('needs a repo, and says when the model or revision is not there', async () => {
      expect(await call('/hf-size')).toMatchObject({ status: 400, data: { error: 'repo is required' } });
      hf.use(http.get('https://huggingface.co/api/models/org/gone/tree/:rev', () => new HttpResponse(null, { status: 404 })));
      expect(await call('/hf-size?repo=org/gone')).toMatchObject({ status: 500, data: { error: 'Model or revision not found: org/gone@main' } });
      expect(await call('/hf-size?repo=org/gone&revision=v2')).toMatchObject({ data: { error: 'Model or revision not found: org/gone@v2' } });
    });

    it('says what went wrong otherwise', async () => {
      hf.use(http.get('https://huggingface.co/api/models/org/model/tree/main', () => new HttpResponse(null, { status: 500 })));
      expect(await call('/hf-size?repo=org/model')).toMatchObject({ status: 500, data: { error: 'Request failed with status code 500' } });
    });

    it('searches text-generation models for vLLM, any for the rest, and the EXL3 collection for TabbyAPI', async () => {
      const seen: string[] = [];
      hf.use(
        http.get('https://huggingface.co/api/models', ({ request }) => {
          seen.push(new URL(request.url).search);
          return HttpResponse.json([{ id: 'org/a', downloads: 5, likes: 1, tags: ['t'] }]);
        }),
        http.get('https://huggingface.co/api/collections/turboderp/exl3-models', () => HttpResponse.json({ items: [
          { repoType: 'model', id: 'turboderp/small', downloads: 1 },
          { repoType: 'model', id: 'turboderp/big', downloads: 9 },
          { repoType: 'dataset', id: 'turboderp/data', downloads: 99 },
        ] })),
      );
      expect((await call('/search?q=qwen&appType=vllm')).data).toEqual([{ id: 'org/a', downloads: 5, likes: 1, tags: ['t'] }]);
      await call('/search?q=qwen');
      expect(seen).toEqual(['?search=qwen&sort=downloads&direction=-1&limit=20&filter=text-generation', '?search=qwen&sort=downloads&direction=-1&limit=20']);
      expect((await call('/search?appType=tabbyapi')).data).toEqual([
        { id: 'turboderp/big', downloads: 9, likes: 0, tags: [] },
        { id: 'turboderp/small', downloads: 1, likes: 0, tags: [] },
      ]);
    });

    it('says why a search failed', async () => {
      hf.use(http.get('https://huggingface.co/api/models', () => new HttpResponse(null, { status: 503 })));
      expect(await call('/search?q=x')).toMatchObject({ status: 500, data: { error: 'Request failed with status code 503' } });
    });

    it('lists a model\'s branches, highest bits per weight first', async () => {
      hf.use(http.get('https://huggingface.co/api/models/org/model/refs', () => HttpResponse.json({ branches: [{ name: 'main' }, { name: '4.0bpw' }, { name: '6.0bpw' }] })));
      expect((await call('/hf-branches?repo=org/model')).data).toEqual(['6.0bpw', '4.0bpw', 'main']);
    });

    it('needs a repo for branches, and says when the model is not there', async () => {
      expect(await call('/hf-branches')).toMatchObject({ status: 400, data: { error: 'repo is required' } });
      hf.use(http.get('https://huggingface.co/api/models/org/gone/refs', () => new HttpResponse(null, { status: 404 })));
      expect(await call('/hf-branches?repo=org/gone')).toMatchObject({ status: 500, data: { error: 'Model not found: org/gone' } });
    });
  });
}
