/**
 * ModelService — Phase A of the agent harness (~/.claude/plans/agent-harness.md).
 *
 * Lists the models a user can actually talk to, and makes one reachable from this process.
 *
 * The reachability problem is the whole job. A vLLM deployment's OpenAI API lives at
 * `http://<ns>-vllm.<ns>.svc.cluster.local:8000/v1` — resolvable only from inside that cluster,
 * which this backend is not (see AppService's own cross-cluster warning, which skips wiring that
 * URL for exactly this reason). Rather than exposing model endpoints publicly, this reuses the
 * kubectl port-forward machinery ClusterProxyService already runs for the Grafana/Traefik
 * dashboards: the forward is process-local, so nothing new becomes reachable from the network.
 */
import axios from 'axios';
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

  /**
   * Every model this user can use, from all sources:
   * 1. App deployments (vLLM, TabbyAPI) in user's clusters
   * 2. User-registered model endpoints
   * 3. Local host Ollama instances when available
   */
  async list(userId: string): Promise<ModelProvider[]> {
    const [deployments, endpoints] = await Promise.all([
      this.apps.getAll(userId),
      this.db.getModelEndpoints(),
    ]);
    const list = listProviders(deployments, endpoints.filter((e) => e.ownerId === userId));

    // Probe local host Ollama if active
    try {
      const ollamaRes = await axios.get('http://127.0.0.1:11434/api/tags', { timeout: 800 });
      if (Array.isArray(ollamaRes.data?.models)) {
        for (const m of ollamaRes.data.models) {
          const modelName = m.name;
          list.push({
            id: `ollama-${modelName}`,
            name: `Ollama: ${modelName}`,
            source: 'endpoint',
            model: modelName,
            baseUrl: 'http://127.0.0.1:11434/v1',
          });
        }
      }
    } catch {
      // Ollama not reachable on localhost
    }

    return list;
  }

  /**
   * Confirms a mesh address is one of this user's OWN devices.
   */
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

  /**
   * Resolves this user's extraction model, if they have chosen one.
   */
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

  /**
   * Resolves a model to an OpenAI-compatible base URL reachable from this process.
   */
  async resolveBaseUrl(
    userId: string,
    modelId?: string,
  ): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string }> {
    const providers = await this.list(userId);
    if (providers.length === 0) {
      throw new Error('No models available. Deploy a vLLM or TabbyAPI app, run Ollama, or register an OpenAI-compatible endpoint.');
    }

    if (modelId) {
      const provider = routeProvider(providers, modelId);
      if (!provider) {
        throw new Error(`Model ${modelId} not found`);
      }
      if (provider.source === 'endpoint') return this.resolveEndpoint(userId, provider);
      return this.resolveDeployment(userId, provider);
    }

    // Try available providers in order of responsiveness (local Ollama or healthy endpoints)
    let lastErr: Error | null = null;
    for (const provider of providers) {
      try {
        if (provider.source === 'endpoint') {
          return await this.resolveEndpoint(userId, provider);
        } else {
          return await this.resolveDeployment(userId, provider);
        }
      } catch (err: any) {
        lastErr = err;
      }
    }

    throw lastErr || new Error('No available models could be reached.');
  }

  /**
   * Registered endpoint: reached directly, across the mesh when the address is in the CGNAT range.
   */
  private async resolveEndpoint(
    userId: string,
    provider: ModelProvider,
  ): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string }> {
    const baseUrl = provider.baseUrl ?? '';

    // Local host Ollama bypasses mesh/SSRF validation
    if (provider.id.startsWith('ollama-') || baseUrl.includes('127.0.0.1:11434') || baseUrl.includes('localhost:11434')) {
      return { provider, baseUrl: baseUrl.replace(/\/$/, '') };
    }

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

  /** Platform-deployed model: only resolvable inside its cluster, so it needs a port-forward. */
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
