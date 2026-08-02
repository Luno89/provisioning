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
   * Every model this user can use, from both sources. Reads through AppService.getAll, which is
   * ownership-filtered, and filters endpoints by ownerId here — never the raw lists, or one tenant
   * would see (and be able to select) another's model.
   */
  async list(userId: string): Promise<ModelProvider[]> {
    const [deployments, endpoints] = await Promise.all([
      this.apps.getAll(userId),
      this.db.getModelEndpoints(),
    ]);
    return listProviders(deployments, endpoints.filter((e) => e.ownerId === userId));
  }

  /**
   * Confirms a mesh address is one of this user's OWN devices.
   *
   * Not optional. The root node carries `tag:platform` in acl.hujson, which grants it `dst: *:*` —
   * it can reach every tenant's machines. Without this check a user could register a neighbour's
   * 100.64.x.x Ollama address and the platform would happily proxy prompts to it, because from the
   * network's point of view the request is perfectly authorised.
   *
   * Fails CLOSED: if Headscale cannot be reached we refuse rather than assume ownership.
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
   *
   * Returns undefined rather than falling back to the conversation model: extracting with a
   * reasoning model is exactly the thing that does not work, so a silent substitution would look
   * like the feature functioning while reproducing the original failure.
   */
  async resolveExtractor(userId: string): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string } | undefined> {
    const user = await this.db.getUserById(userId);
    const chosen = user?.extractionModelId;
    if (!chosen) return undefined;
    try {
      return await this.resolveBaseUrl(userId, chosen);
    } catch {
      // A deleted or unreachable extractor must not fail the chat it was called from.
      return undefined;
    }
  }

  /**
   * Resolves a model to an OpenAI-compatible base URL reachable from this process, standing up a
   * port-forward if one is not already running.
   *
   * Throws rather than falling back to a different model: silently rerouting a prompt to somewhere
   * the user did not choose is worse than an error, especially once personas and tools exist.
   */
  async resolveBaseUrl(
    userId: string,
    modelId?: string,
  ): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string }> {
    const providers = await this.list(userId);
    if (providers.length === 0) {
      throw new Error('No models available. Deploy a vLLM or TabbyAPI app, or register an OpenAI-compatible endpoint.');
    }

    const provider = routeProvider(providers, modelId);
    if (!provider) {
      // Ownership-filtered list above, so an unmatched id means "not yours" as much as "no such
      // model" — same conflation ClusterService.getById makes deliberately.
      throw new Error(`Model ${modelId} not found`);
    }

    if (provider.source === 'endpoint') return this.resolveEndpoint(userId, provider);
    return this.resolveDeployment(userId, provider);
  }

  /**
   * Registered endpoint: reached directly, across the mesh when the address is in the CGNAT range.
   *
   * The URL was validated at registration, but it is re-validated here rather than trusted. A
   * record can be older than the current rules, and the cost of re-checking a parsed URL is
   * nothing compared to the cost of the one case where it matters.
   */
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

  /** Platform-deployed model: only resolvable inside its cluster, so it needs a port-forward. */
  private async resolveDeployment(
    userId: string,
    provider: ModelProvider,
  ): Promise<{ provider: ModelProvider; baseUrl: string }> {
    const { clusterId, service, namespace, port } = provider;
    // providerFromDeployment always sets these together; if one is missing the record is malformed
    // rather than the caller being wrong, so say so instead of asserting non-null and forwarding to
    // "undefined" in a namespace called "undefined".
    if (!clusterId || !service || !namespace || port === undefined) {
      throw new Error(`Model ${provider.name} is missing its cluster location — it may need redeploying`);
    }

    const cluster = await this.clusters.getById(clusterId, userId);
    if (!cluster) throw new Error(`Cluster for model ${provider.name} not found`);
    const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);

    // Cache key must be unique per model, not per service kind — two vLLM deployments on one
    // cluster would otherwise share (and fight over) a single forward.
    const forwardUrl = await this.proxy.ensurePortForward(
      clusterId,
      `model:${provider.id}`,
      kubeconfigPath,
      { service, namespace, remotePort: port },
    );

    return { provider, baseUrl: `${forwardUrl.replace(/\/$/, '')}/v1` };
  }
}
