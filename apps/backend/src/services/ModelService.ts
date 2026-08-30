import { BaseService } from './BaseService.js';
import type { Database } from '../lib/db-interface.js';
import type { AppService } from './AppService.js';
import type { ClusterService } from './ClusterService.js';
import type { ClusterProxyService } from './ClusterProxyService.js';
import { listProviders, routeProvider, type ModelProvider } from '../lib/model-registry.js';
import { checkEndpointUrl, isMeshAddress } from '../lib/endpoint-url-safety.js';
import { decryptValue } from '../lib/crypto.js';
import type { HeadscaleService } from './HeadscaleService.js';

export class ModelService extends BaseService {
  constructor(
    db: Database,
    private apps: AppService,
    private clusters: ClusterService,
    private proxy: ClusterProxyService,
    private headscale: HeadscaleService,
    private masterKey: string,
  ) {
    super(db);
  }

  async list(userId: string): Promise<ModelProvider[]> {
    const [deployments, endpoints] = await Promise.all([
      this.apps.getAll(userId),
      this.db.getModelEndpoints(),
    ]);
    return listProviders(deployments, endpoints.filter((e) => e.ownerId === userId));
  }

  private async assertOwnsMeshAddress(userId: string, host: string): Promise<void> {
    let devices;
    try {
      devices = await this.headscale.listUserDevices(userId);
    } catch (err: any) {
      throw new Error(`Cannot verify ownership of ${host} — the mesh is unreachable (${err.message})`);
    }
    const owned = devices.some((d) => d.ipAddresses.includes(host));
    if (!owned) {
      throw new Error(`${host} is not one of your machines. Join it under My Machines first.`);
    }
  }

  async resolveExtractor(userId: string): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string } | undefined> {
    const user = await this.db.getUserById(userId);
    const chosen = user?.extractionModelId;
    if (!chosen) return undefined;
    try {
      return await this.resolveBaseUrl(userId, chosen);
    } catch {
      return undefined;
    }
  }

  async resolveBaseUrl(
    userId: string,
    modelId?: string,
    packEndpointId?: string,
  ): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string }> {
    const providers = await this.list(userId);
    if (providers.length === 0) {
      throw new Error('No models available. Deploy a vLLM or TabbyAPI app, or register an OpenAI-compatible endpoint.');
    }

    /**
     * With one endpoint there is nothing to choose between, so a pack that names none still runs.
     * With several there is, and picking the first silently is how a run ends up attributed to a
     * model it did not use — so that is an error naming the packs' own setting.
     */
    const only = providers.length === 1 ? providers[0]!.id : undefined;
    const provider = routeProvider(providers, modelId, packEndpointId ?? only);
    if (!provider) {
      const named = modelId ?? packEndpointId;
      throw new Error(named
        ? `Model ${named} not found`
        : `This account has ${providers.length} endpoints and nothing named one. `
          + 'Set the pack\'s model.endpointId, or name a model on the request.');
    }

    if (provider.source === 'endpoint') return this.resolveEndpoint(userId, provider);
    return this.resolveDeployment(userId, provider);
  }

  private async resolveEndpoint(
    userId: string,
    provider: ModelProvider,
  ): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string }> {
    const baseUrl = provider.baseUrl ?? '';
    const check = checkEndpointUrl(baseUrl);
    if (!check.ok) throw new Error(`Endpoint "${provider.name}" is no longer allowed: ${check.reason}`);

    if (check.literalIp && isMeshAddress(check.literalIp)) {
      await this.assertOwnsMeshAddress(userId, check.literalIp);
    }

    const endpoints = await this.db.getModelEndpoints();
    const record = endpoints.find((e) => e.id === provider.id && e.ownerId === userId);
    const apiKey = record?.apiKeyEnc ? decryptValue(record.apiKeyEnc, this.masterKey) : undefined;

    return { provider, baseUrl: baseUrl.replace(/\/$/, ''), ...(apiKey ? { apiKey } : {}) };
  }

  private async resolveDeployment(
    userId: string,
    provider: ModelProvider,
  ): Promise<{ provider: ModelProvider; baseUrl: string }> {
    const { clusterId, service, namespace, port } = provider;
    if (!clusterId || !service || !namespace || port === undefined) {
      throw new Error(`Model ${provider.name} is missing its cluster location — it may need redeploying`);
    }

    const cluster = await this.clusters.getById(clusterId, userId);
    if (!cluster) throw new Error(`Cluster for model ${provider.name} not found`);
    const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);

    const forwardUrl = await this.proxy.ensurePortForward(
      clusterId,
      `model:${provider.id}`,
      kubeconfigPath,
      { service, namespace, remotePort: port },
    );

    return { provider, baseUrl: `${forwardUrl.replace(/\/$/, '')}/v1` };
  }
}
