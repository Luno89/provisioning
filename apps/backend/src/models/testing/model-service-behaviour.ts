import dns from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { AppService, ClusterService, ClusterProxyService, HeadscaleService } from '../../infrastructure/index.js';
import { encryptValue } from '../../platform/lib/crypto.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { asPerson } from '../../platform/lib/permissions.js';
import type { ClusterMetadata, DeploymentMetadata, ModelEndpointMetadata, UserMetadata } from '../../platform/lib/types.js';
import type { EndpointRules } from '../lib/endpoint-url-safety.js';
import { ModelService } from '../services/ModelService.js';

const gatewayEndpoints = (ownerId: string, count: number): ModelEndpointMetadata[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `openrouter-${i}`,
    ownerId,
    name: `OpenRouter · vendor/model-${i}`,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: `vendor/model-${i}`,
    createdAt: new Date().toISOString(),
  }));

const deployment = (fields: Partial<DeploymentMetadata> = {}): DeploymentMetadata =>
  ({ id: 'vllm-1', name: 'Qwen', appType: 'vllm', status: 'running', clusterId: 'c1', namespace: 'qwen', vllmModel: 'Qwen/Qwen3', ownerId: 'u1', strategy: 'native', createdAt: 'then', ...fields }) as DeploymentMetadata;

const privateNetwork = vi.spyOn(dns, 'lookup');

let db: Database;
let apps: MockProxy<AppService>;
let clusters: MockProxy<ClusterService>;
let proxy: MockProxy<ClusterProxyService>;
let headscale: MockProxy<HeadscaleService>;

const user = (fields: Partial<UserMetadata> = {}): UserMetadata =>
  ({ id: 'u1', email: 'u@example.com', emailVerified: true, createdAt: new Date().toISOString(), ...fields }) as UserMetadata;

const build = async (endpoints: ModelEndpointMetadata[], account?: Partial<UserMetadata>, rules: EndpointRules = {}) => {
  for (const endpoint of endpoints) await db.models.saveModelEndpoint(endpoint);
  await db.accounts.saveUser(user(account));
  return new ModelService(db, apps, clusters, proxy, headscale, 'master-key', rules);
};

export function modelServiceBehaviour(make: () => Promise<Database>): void {
  beforeEach(async () => {
    db = await make();
    apps = mock<AppService>();
    apps.getAll.mockResolvedValue([]);
    clusters = mock<ClusterService>();
    proxy = mock<ClusterProxyService>();
    headscale = mock<HeadscaleService>();
    privateNetwork.mockReset();
    privateNetwork.mockImplementation((async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof dns.lookup);
  });

  afterEach(() => {
    privateNetwork.mockReset();
  });

  describe('the engine a run reaches', () => {
    it('refuses to guess among many endpoints when nothing names one', async () => {
      const models = await build(gatewayEndpoints('u1', 425));
      await expect(models.resolveBaseUrl('u1')).rejects.toThrow(/425 endpoints and nothing named one/);
    });

    it('names all three settings that would fix it, so the message is actionable', async () => {
      const models = await build(gatewayEndpoints('u1', 425));
      await expect(models.resolveBaseUrl('u1')).rejects.toThrow(/default model for the account/);
      await expect(models.resolveBaseUrl('u1')).rejects.toThrow(/model\.endpointId/);
    });

    it('runs on the account default when the pack names no engine', async () => {
      const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
      const resolved = await models.resolveBaseUrl('u1');
      expect(resolved.provider.id).toBe('openrouter-7');
      expect(resolved.source).toBe('global');
      expect(resolved.baseUrl).toBe('https://openrouter.ai/api/v1');
    });

    it('lets the pack\'s own engine beat the account default', async () => {
      const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
      const resolved = await models.resolveBaseUrl('u1', undefined, 'openrouter-3');
      expect(resolved.provider.id).toBe('openrouter-3');
      expect(resolved.source).toBe('pack');
    });

    it('lets an explicit request beat both', async () => {
      const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
      const resolved = await models.resolveBaseUrl('u1', 'openrouter-1', 'openrouter-3');
      expect(resolved.provider.id).toBe('openrouter-1');
      expect(resolved.source).toBe('request');
    });

    it('treats a cleared pack endpoint as naming nothing, not as an id to look up', async () => {
      const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
      const resolved = await models.resolveBaseUrl('u1', undefined, null);
      expect(resolved.provider.id).toBe('openrouter-7');
      expect(resolved.source).toBe('global');
    });

    it('honours the account override, so a pinned pack runs on the default too', async () => {
      const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7', globalModelOverride: true });
      const resolved = await models.resolveBaseUrl('u1', undefined, 'openrouter-3');
      expect(resolved.provider.id).toBe('openrouter-7');
      expect(resolved.source).toBe('global');
    });

    it('puts the pack back on its own engine when the override is off', async () => {
      const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7', globalModelOverride: false });
      const resolved = await models.resolveBaseUrl('u1', undefined, 'openrouter-3');
      expect(resolved.provider.id).toBe('openrouter-3');
      expect(resolved.source).toBe('pack');
    });

    it('still runs a sole endpoint that nothing names, and says so', async () => {
      const models = await build(gatewayEndpoints('u1', 1));
      const resolved = await models.resolveBaseUrl('u1');
      expect(resolved.provider.id).toBe('openrouter-0');
      expect(resolved.source).toBe('sole');
    });

    it('errors rather than falling back to the default when a named endpoint is gone', async () => {
      const models = await build(gatewayEndpoints('u1', 425), { defaultModelId: 'openrouter-7' });
      await expect(models.resolveBaseUrl('u1', undefined, 'deleted')).rejects.toThrow(/Model deleted not found/);
    });

    it('says plainly what to do when the default is an agent on a machine and the work cannot go there', async () => {
      const said = /Your default is an agent on your machine, and this work cannot be handed to a machine/;
      await expect((await build([], { defaultModelId: 'machine:d1:claude-code' })).resolveBaseUrl('u1')).rejects.toThrow(said);
      await expect((await build(gatewayEndpoints('u1', 3), { defaultModelId: 'machine:d1:claude-code' })).resolveBaseUrl('u1')).rejects.toThrow(said);
      expect((await (await build(gatewayEndpoints('u1', 3), { defaultModelId: 'machine:d1:claude-code' })).resolveBaseUrl('u1', 'openrouter-2')).provider.id).toBe('openrouter-2');
    });

    it('does not reach another tenant\'s endpoint through the default', async () => {
      const models = await build(gatewayEndpoints('u2', 3), { defaultModelId: 'openrouter-1' });
      await expect(models.resolveBaseUrl('u1')).rejects.toThrow(/No models available/);
    });

    it('says there are no models when nothing is deployed or registered', async () => {
      await expect((await build([])).route('u1')).rejects.toThrow('No models available. Deploy a vLLM or TabbyAPI app, or register an OpenAI-compatible endpoint.');
    });

    it('routes with the owner, the provider and the layer that named it', async () => {
      const models = await build(gatewayEndpoints('u1', 3), { defaultModelId: 'openrouter-1' });
      expect(await models.route('u1')).toMatchObject({ owner: 'u1', provider: { id: 'openrouter-1' }, source: 'global' });
    });
  });

  describe('the models a person has', () => {
    it('lists their running model apps and their endpoints, and not another person\'s', async () => {
      apps.getAll.mockResolvedValue([deployment(), deployment({ id: 'stopped', status: 'failed' })]);
      const models = await build([...gatewayEndpoints('u1', 1), ...gatewayEndpoints('u2', 2).map((endpoint) => ({ ...endpoint, id: `u2-${endpoint.id}` }))]);
      expect((await models.list('u1')).map((provider) => provider.id)).toEqual(['vllm-1', 'openrouter-0']);
      expect(apps.getAll).toHaveBeenCalledWith('u1');
    });

    it('lets a check space borrow its person\'s models, on the person\'s default, with nothing of its own', async () => {
      const models = await build(gatewayEndpoints('u1', 3), { defaultModelId: 'openrouter-2' });
      await db.accounts.saveUser(user({ id: 'space-1', email: 'space-1@checks.internal', space: { person: 'u1', checkRunId: 'c1', scenarioId: 's1' } } as Partial<UserMetadata>));

      expect((await models.list('space-1')).map((provider) => provider.id)).toEqual(['openrouter-0', 'openrouter-1', 'openrouter-2']);
      const resolved = await models.resolveBaseUrl('space-1');
      expect(resolved.provider.id).toBe('openrouter-2');
      expect(resolved.source).toBe('global');
      expect(apps.getAll).toHaveBeenCalledWith('u1');
    });
  });

  describe('an endpoint\'s address and key', () => {
    it('hands back the key the person stored, unsealed, and the address without its trailing slash', async () => {
      const models = await build([{ ...gatewayEndpoints('u1', 1)[0]!, baseUrl: 'https://openrouter.ai/api/v1/', apiKeyEnc: encryptValue('sk-secret', 'master-key') }]);
      expect(await models.resolveBaseUrl('u1')).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-secret' });
    });

    it('hands back no key where none was stored', async () => {
      const resolved = await (await build(gatewayEndpoints('u1', 1))).resolveBaseUrl('u1');
      expect(resolved).not.toHaveProperty('apiKey');
    });

    it('refuses an endpoint whose address is no longer allowed', async () => {
      const models = await build([{ ...gatewayEndpoints('u1', 1)[0]!, name: 'Local', baseUrl: 'http://10.0.0.5:8000/v1' }]);
      await expect(models.resolveBaseUrl('u1')).rejects.toThrow(/Endpoint "Local" is no longer allowed: 10\.0\.0\.5 is a private/);
    });

    it('is refused when its name resolves to this machine or the private network, as an address would be', async () => {
      privateNetwork.mockImplementation((async (host: string) => (host === '127.0.0.1.nip.io' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }])) as unknown as typeof dns.lookup);
      const sneaky = await build([{ id: 'sneaky', ownerId: 'u1', name: 'Sneaky', baseUrl: 'http://127.0.0.1.nip.io:3001/api', model: 'm', createdAt: 't' }], { defaultModelId: 'sneaky' });
      await expect(sneaky.resolveBaseUrl('u1')).rejects.toThrow('Endpoint "Sneaky" is no longer allowed: 127.0.0.1.nip.io resolves to 127.0.0.1 is a private, loopback, mesh or reserved address');
    });

    it('is allowed when its name resolves to a public address', async () => {
      const honest = await build([{ id: 'honest', ownerId: 'u1', name: 'Honest', baseUrl: 'https://models.example.com/v1', model: 'm', createdAt: 't' }], { defaultModelId: 'honest' });
      expect((await honest.resolveBaseUrl('u1')).baseUrl).toBe('https://models.example.com/v1');
      expect(privateNetwork).toHaveBeenCalledWith('models.example.com', { all: true });
    });

    it('says so when its name does not resolve', async () => {
      privateNetwork.mockRejectedValue(new Error('ENOTFOUND'));
      const models = await build([{ id: 'gone', ownerId: 'u1', name: 'Gone', baseUrl: 'https://gone.example.com/v1', model: 'm', createdAt: 't' }]);
      await expect(models.resolveBaseUrl('u1')).rejects.toThrow('Endpoint "Gone" cannot be checked: gone.example.com does not resolve (ENOTFOUND)');
    });

    it('reaches a check space\'s scripted model without looking its address up', async () => {
      const base = 'https://koala.example/api/checks/scripted';
      const endpoint: ModelEndpointMetadata = { id: 'scripted', ownerId: 'space-1', name: 'Scripted', baseUrl: `${base}/space-1/v1`, model: 'scripted', createdAt: 't' };
      await db.models.saveModelEndpoint(endpoint);
      await db.accounts.saveUser(user({ id: 'space-1', email: 'space-1@checks.internal', space: { person: 'u1', checkRunId: 'c1', scenarioId: 's1', models: 'scripted' } } as Partial<UserMetadata>));
      const models = new ModelService(db, apps, clusters, proxy, headscale, 'master-key', { scriptedBase: base });
      apps.getAll.mockResolvedValue([]);
      expect((await models.resolveBaseUrl('space-1', 'scripted')).baseUrl).toBe(`${base}/space-1/v1`);
      expect(privateNetwork).not.toHaveBeenCalled();
    });
  });

  describe('an endpoint on the mesh', () => {
    const meshEndpoint = (baseUrl: string): ModelEndpointMetadata => ({ id: 'mesh', ownerId: 'u1', name: 'Mine', baseUrl, model: 'm', isMesh: true, createdAt: 't' });
    const device = (ipAddresses: string[]) => ({ id: 'n1', name: 'box', ipAddresses, online: true }) as Awaited<ReturnType<HeadscaleService['listUserDevices']>>[number];

    it('is reached when it is one of the person\'s own machines', async () => {
      headscale.listUserDevices.calledWith('u1').mockResolvedValue([device(['100.64.0.7'])]);
      const models = await build([meshEndpoint('http://100.64.0.7:8000/v1')]);
      expect((await models.resolveBaseUrl('u1')).baseUrl).toBe('http://100.64.0.7:8000/v1');
    });

    it('is refused when the address is another person\'s machine', async () => {
      headscale.listUserDevices.mockResolvedValue([device(['100.64.0.9'])]);
      const models = await build([meshEndpoint('http://100.64.0.7:8000/v1')]);
      await expect(models.resolveBaseUrl('u1')).rejects.toThrow('100.64.0.7 is not one of your machines. Join it under My Machines first.');
    });

    it('is refused when the mesh cannot be asked', async () => {
      headscale.listUserDevices.mockRejectedValue(new Error('connection refused'));
      const models = await build([meshEndpoint('http://100.64.0.7:8000/v1')]);
      await expect(models.resolveBaseUrl('u1')).rejects.toThrow('Cannot verify ownership of 100.64.0.7 — the mesh is unreachable (connection refused)');
    });

    it('is checked too when a name resolves to a mesh address', async () => {
      privateNetwork.mockResolvedValue([{ address: '100.64.0.7', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
      headscale.listUserDevices.mockResolvedValue([]);
      const models = await build([meshEndpoint('http://box.example.com:8000/v1')]);
      await expect(models.resolveBaseUrl('u1')).rejects.toThrow('100.64.0.7 is not one of your machines');
    });
  });

  describe('a model deployed as an app', () => {
    const cluster = { id: 'c1', name: 'c1', provider: 'k3d', status: 'healthy' } as ClusterMetadata;

    it('is reached through the cluster\'s proxy at the service it runs as', async () => {
      apps.getAll.mockResolvedValue([deployment()]);
      clusters.getById.mockResolvedValue(cluster);
      clusters.getKubeconfigPath.calledWith(cluster).mockResolvedValue('/kube/c1');
      proxy.serviceUrl.mockResolvedValue('http://127.0.0.1:41000/');
      const models = await build([]);

      const resolved = await models.resolveBaseUrl('u1', 'vllm-1');

      expect(resolved).toMatchObject({ baseUrl: 'http://127.0.0.1:41000/v1', source: 'request', provider: { id: 'vllm-1' } });
      expect(proxy.serviceUrl).toHaveBeenCalledWith('c1', 'model:vllm-1', '/kube/c1', { service: 'qwen-vllm', namespace: 'qwen', remotePort: 8000 });
      expect(clusters.getById).toHaveBeenCalledWith('c1', asPerson('u1'));
    });

    it('says so when its cluster is gone', async () => {
      apps.getAll.mockResolvedValue([deployment()]);
      clusters.getById.mockResolvedValue(undefined);
      await expect((await build([])).resolveBaseUrl('u1', 'vllm-1')).rejects.toThrow('Cluster for model Qwen not found');
    });
  });

  describe('the model that reads documents for a person', () => {
    it('is the one they chose, resolved', async () => {
      const models = await build(gatewayEndpoints('u1', 3), { extractionModelId: 'openrouter-1' });
      expect(await models.resolveExtractor('u1')).toMatchObject({ provider: { id: 'openrouter-1' }, baseUrl: 'https://openrouter.ai/api/v1' });
    });

    it('is none when they chose none, or the one they chose is gone', async () => {
      expect(await (await build(gatewayEndpoints('u1', 2))).resolveExtractor('u1')).toBeUndefined();
      await db.accounts.saveUser(user({ extractionModelId: 'deleted' }));
      expect(await new ModelService(db, apps, clusters, proxy, headscale, 'master-key').resolveExtractor('u1')).toBeUndefined();
      expect(await new ModelService(db, apps, clusters, proxy, headscale, 'master-key').resolveExtractor('nobody')).toBeUndefined();
    });
  });
}
