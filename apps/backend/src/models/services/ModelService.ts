import dns from 'node:dns/promises';
import { addressProblem, asPerson, BaseService, type Database, decryptValue, type DeploymentMetadata, type SecretKey } from '../../platform/index.js';
import type { ClusterService, ClusterProxyService, HeadscaleService } from '../../infrastructure/index.js';
import { cannotChat, listProviders, routeProvider, type ModelProvider, type EndpointSource } from '../lib/model-registry.js';
import { checkEndpointUrl, isMeshAddress, type EndpointRules } from '../lib/endpoint-url-safety.js';
import { modelOwner } from '../../checks/lib/check-space.js';
import { MACHINE_DEFAULT_NEEDS_MODEL } from '../../machines/index.js';
import { machineChoice } from '@koala/agent-engine/procedure';
import type { ServedWindows } from './served-windows.js';
import { ignore } from '@koala/engine-core/failures';

export interface AppRecords {
  getAll(userId: string): Promise<DeploymentMetadata[]>;
}

export class ModelService extends BaseService {
  constructor(
    db: Database,
    private apps: AppRecords,
    private clusters: ClusterService,
    private proxy: ClusterProxyService,
    private headscale: HeadscaleService,
    private windows: ServedWindows,
    private masterKey: SecretKey,
    private endpointRules: EndpointRules = {},
  ) {
    super(db);
  }

  private async modelOwner(userId: string): Promise<string> {
    return modelOwner(await this.db.accounts.getUserById(userId), userId);
  }

  async list(userId: string): Promise<ModelProvider[]> {
    const owner = await this.modelOwner(userId);
    const [deployments, endpoints] = await Promise.all([
      this.apps.getAll(owner),
      this.db.models.getModelEndpoints(),
    ]);
    return listProviders(deployments, endpoints.filter((e) => e.ownerId === owner));
  }

  private async assertOwnsMeshAddress(userId: string, host: string): Promise<void> {
    let devices;
    try {
      devices = await this.headscale.listUserDevices(userId);
    } catch (err) {
      throw new Error(`Cannot verify ownership of ${host} — the mesh is unreachable (${(err as Error).message})`);
    }
    const owned = devices.some((d) => d.ipAddresses.includes(host));
    if (!owned) {
      throw new Error(`${host} is not one of your machines. Join it under My Machines first.`);
    }
  }

  async resolveExtractor(userId: string): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string } | undefined> {
    const user = await this.db.accounts.getUserById(userId);
    const chosen = user?.extractionModelId;
    if (!chosen) return undefined;
    try {
      return await this.resolveBaseUrl(userId, chosen);
    } catch {
      return undefined;
    }
  }

  async route(
    userId: string,
    modelId?: string | null,
    packEndpointId?: string | null,
  ): Promise<{ owner: string; provider: ModelProvider; source: EndpointSource }> {
    const owner = await this.modelOwner(userId);
    const providers = await this.list(owner);
    const user = await this.db.accounts.getUserById(owner);
    const onMachine = machineChoice(user?.defaultModelId) ? user!.defaultModelId : undefined;
    if (providers.length === 0) {
      throw new Error(onMachine && !modelId && !packEndpointId
        ? MACHINE_DEFAULT_NEEDS_MODEL
        : 'No models available. Deploy a vLLM or TabbyAPI app, or register an OpenAI-compatible endpoint.');
    }

    const routed = routeProvider(providers, modelId, packEndpointId, onMachine ? undefined : user?.defaultModelId,
      { overrideGlobal: user?.globalModelOverride === true })
      /**
       * With one endpoint there is nothing to choose between, so a pack that names none still runs.
       * With several there is, and picking the first silently is how a run ends up attributed to a
       * model it did not use — so that is an error naming the settings that would fix it.
       */
      ?? (providers.length === 1 ? { provider: providers[0]!, source: 'sole' as const } : undefined);

    if (!routed) {
      const named = modelId ?? packEndpointId ?? (onMachine ? undefined : user?.defaultModelId);
      if (!named && onMachine) throw new Error(MACHINE_DEFAULT_NEEDS_MODEL);
      throw new Error(named
        ? `Model ${named} not found`
        : `This account has ${providers.length} endpoints and nothing named one. `
          + 'Set a default model for the account, the pack\'s model.endpointId, '
          + 'or name a model on the request.');
    }

    const refused = cannotChat(routed.provider);
    if (refused) throw new Error(refused);
    return { owner, ...routed };
  }

  async resolveBaseUrl(
    userId: string,
    modelId?: string | null,
    packEndpointId?: string | null,
  ): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string; source: EndpointSource }> {
    const { owner, provider, source } = await this.route(userId, modelId, packEndpointId);
    const resolved = provider.source === 'endpoint'
      ? await this.resolveEndpoint(owner, provider)
      : await this.resolveDeployment(owner, provider);
    return { ...resolved, provider: await this.asServed(resolved), source };
  }

  async listAsServed(userId: string): Promise<ModelProvider[]> {
    const owner = await this.modelOwner(userId);
    return Promise.all((await this.list(userId)).map(async (provider) => {
      if (provider.source !== 'deployment') return provider;
      const resolved = await this.resolveDeployment(owner, provider)
        .catch(ignore('a model whose cluster cannot be reached now is listed with the window its settings name, and a run on it says why it cannot reach it'));
      return resolved ? this.asServed(resolved) : provider;
    }));
  }

  private async asServed({ provider, baseUrl, apiKey }: { provider: ModelProvider; baseUrl: string; apiKey?: string }): Promise<ModelProvider> {
    if (provider.source !== 'deployment' && provider.contextTokens !== undefined) return provider;
    const served = await this.windows.read({ baseUrl, kind: provider.kind, model: provider.model, apiKey });
    return served ? { ...provider, contextTokens: served } : provider;
  }

  private async resolveEndpoint(
    userId: string,
    provider: ModelProvider,
  ): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string }> {
    const baseUrl = provider.baseUrl ?? '';
    const owner = await this.db.accounts.getUserById(userId);
    const scripted = owner?.space?.models === 'scripted' && this.endpointRules.scriptedBase !== undefined && baseUrl === `${this.endpointRules.scriptedBase}/${userId}/v1`;
    const check = scripted ? { ok: true as const } : checkEndpointUrl(baseUrl, this.endpointRules);
    if (!check.ok) throw new Error(`Endpoint "${provider.name}" is no longer allowed: ${check.reason}`);

    if (check.literalIp && isMeshAddress(check.literalIp)) {
      await this.assertOwnsMeshAddress(userId, check.literalIp);
    }
    if (!scripted && !this.endpointRules.lab && !check.literalIp && check.hostname) {
      const addresses = await dns.lookup(check.hostname, { all: true }).catch((err: Error) => {
        throw new Error(`Endpoint "${provider.name}" cannot be checked: ${check.hostname} does not resolve (${err.message})`);
      });
      for (const { address } of addresses) {
        if (isMeshAddress(address)) await this.assertOwnsMeshAddress(userId, address);
        else if (addressProblem(address)) throw new Error(`Endpoint "${provider.name}" is no longer allowed: ${check.hostname} resolves to ${addressProblem(address)}`);
      }
    }

    const endpoints = await this.db.models.getModelEndpoints();
    const record = endpoints.find((e) => e.id === provider.id && e.ownerId === userId);
    const apiKey = record?.apiKeyEnc ? decryptValue(record.apiKeyEnc, this.masterKey) : undefined;

    return { provider, baseUrl: baseUrl.replace(/\/$/, ''), ...(apiKey ? { apiKey } : {}) };
  }

  private async resolveDeployment(
    userId: string,
    provider: ModelProvider,
  ): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string }> {
    const { clusterId, service, namespace, port } = provider;
    if (!clusterId || !service || !namespace || port === undefined) {
      throw new Error(`Model ${provider.name} is missing its cluster location — it may need redeploying`);
    }

    const cluster = await this.clusters.getById(clusterId, asPerson(userId));
    if (!cluster) throw new Error(`Cluster for model ${provider.name} not found`);
    const target = { service, namespace, remotePort: port };
    const url = await this.proxy.serviceUrl(cluster.id, `model:${provider.id}`, target);

    return { provider, baseUrl: `${url.replace(/\/$/, '')}/v1` };
  }
}
