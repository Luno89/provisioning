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
import { BaseService } from './BaseService.js';
import type { Database } from '../lib/db-interface.js';
import type { AppService } from './AppService.js';
import type { ClusterService } from './ClusterService.js';
import type { ClusterProxyService } from './ClusterProxyService.js';
import { listProviders, routeProvider, type ModelProvider } from '../lib/model-registry.js';

export class ModelService extends BaseService {
  constructor(
    db: Database,
    private apps: AppService,
    private clusters: ClusterService,
    private proxy: ClusterProxyService,
  ) {
    super(db);
  }

  /**
   * Every model this user can use. Reads through AppService.getAll, which is ownership-filtered —
   * never the raw deployment list, or one tenant would see (and be able to select) another's model.
   */
  async list(userId: string): Promise<ModelProvider[]> {
    const deployments = await this.apps.getAll(userId);
    return listProviders(deployments);
  }

  /**
   * Resolves a model to an OpenAI-compatible base URL reachable from this process, standing up a
   * port-forward if one is not already running.
   *
   * Throws rather than falling back to a different model: silently rerouting a prompt to somewhere
   * the user did not choose is worse than an error, especially once personas and tools exist.
   */
  async resolveBaseUrl(userId: string, modelId?: string): Promise<{ provider: ModelProvider; baseUrl: string }> {
    const providers = await this.list(userId);
    if (providers.length === 0) {
      throw new Error('No running model endpoints. Deploy a vLLM or TabbyAPI app first.');
    }

    const provider = routeProvider(providers, modelId);
    if (!provider) {
      // Ownership-filtered list above, so an unmatched id means "not yours" as much as "no such
      // model" — same conflation ClusterService.getById makes deliberately.
      throw new Error(`Model ${modelId} not found`);
    }

    const cluster = await this.clusters.getById(provider.clusterId, userId);
    if (!cluster) throw new Error(`Cluster for model ${provider.name} not found`);
    const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);

    // Cache key must be unique per model, not per service kind — two vLLM deployments on one
    // cluster would otherwise share (and fight over) a single forward.
    const forwardUrl = await this.proxy.ensurePortForward(
      provider.clusterId,
      `model:${provider.id}`,
      kubeconfigPath,
      { service: provider.service, namespace: provider.namespace, remotePort: provider.port },
    );

    return { provider, baseUrl: `${forwardUrl.replace(/\/$/, '')}/v1` };
  }
}
