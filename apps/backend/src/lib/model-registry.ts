/**
 * Model registry — Phase A of the agent harness (~/.claude/plans/agent-harness.md).
 *
 * Turns a user's running inference deployments into a list of usable model providers. Deliberately
 * pure: given deployment records it derives where each model lives, with no I/O, so the
 * service-name and namespace derivation can be tested directly. Getting that derivation wrong
 * produces a port-forward to a service that does not exist, which surfaces as a confusing timeout
 * rather than an error.
 *
 * Phase A covers SELF-HOSTED models only. The bring-your-own-subscription tier runs an agent CLI
 * inside a workspace pod, which does not exist until Phase C — see the plan. Users with no
 * self-hosted model see an empty list, which is a real state to render, not an error.
 */
import type { DeploymentMetadata, ModelEndpointMetadata } from './types.js';

export type ModelKind = 'vllm' | 'tabbyapi';

/**
 * Where a provider lives, which decides how it is reached:
 *
 * - `deployment` — an app this platform deployed. Reached through a kubectl port-forward, because
 *   its Service is only resolvable inside its own cluster.
 * - `endpoint` — any OpenAI-compatible API the user registered: Ollama on their laptop, llama.cpp,
 *   LM Studio, a vLLM outside the platform, a hosted provider. Reached directly over HTTP, across
 *   the mesh when the address is in the CGNAT range.
 */
export type ModelSource = 'deployment' | 'endpoint';

export interface ModelProvider {
  /** Stable id — the deployment id or the endpoint id. What the chat route takes as its selector. */
  id: string;
  name: string;
  source: ModelSource;
  /** Engine, when the platform deployed it and therefore knows. Absent for registered endpoints. */
  kind?: ModelKind;
  /** What the endpoint serves, e.g. "meta-llama/Llama-3.1-8B". Empty means "the endpoint's default". */
  model: string;

  // ── source === 'deployment' ──
  clusterId?: string;
  namespace?: string;
  service?: string;
  port?: number;
  gpuCount?: number;

  // ── source === 'endpoint' ──
  /** Already validated by endpoint-url-safety.ts before it was ever stored. */
  baseUrl?: string;
  /** Host is in 100.64.0.0/10, so ownership must be re-checked against the caller's mesh devices. */
  isMesh?: boolean;
  hasApiKey?: boolean;
}

/**
 * Kubernetes namespace for a deployment name.
 *
 * MUST stay identical to the derivation AppService uses when it creates the namespace — two copies
 * that drift mean this looks in the wrong place and finds nothing. Shared rather than duplicated
 * for exactly that reason.
 */
export function sanitizeNamespace(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Service name and port per engine, matching the CDKTF constructs that create them:
 * `${sanitizedName}-vllm` on 8000 (constructs/vllm.ts) and `${sanitizedName}-tabbyapi` on 5000.
 */
const ENGINES: Record<ModelKind, { suffix: string; port: number }> = {
  vllm: { suffix: 'vllm', port: 8000 },
  tabbyapi: { suffix: 'tabbyapi', port: 5000 },
};

export function isModelKind(appType: string | undefined): appType is ModelKind {
  return appType === 'vllm' || appType === 'tabbyapi';
}

/**
 * Returns undefined for anything that is not a usable model endpoint — wrong app type, or not
 * running yet. A deploying or failed endpoint would accept a port-forward and then hang, so it is
 * excluded here rather than discovered at request time.
 */
export function providerFromDeployment(dep: DeploymentMetadata): ModelProvider | undefined {
  if (!isModelKind(dep.appType)) return undefined;
  if (dep.status !== 'running') return undefined;

  const engine = ENGINES[dep.appType];
  const namespace = sanitizeNamespace(dep.name);
  if (!namespace) return undefined;

  const model = (dep.appType === 'vllm' ? dep.vllmModel : dep.tabbyModel) ?? '';

  return {
    id: dep.id,
    name: dep.name,
    source: 'deployment',
    kind: dep.appType,
    model,
    clusterId: dep.clusterId,
    namespace,
    service: `${namespace}-${engine.suffix}`,
    port: engine.port,
    ...(dep.vllmGpuCount !== undefined ? { gpuCount: dep.vllmGpuCount } : {}),
  };
}

/**
 * A registered endpoint as a provider.
 *
 * No status filtering: unlike a deployment, the platform does not manage this thing's lifecycle and
 * has no reliable signal about whether it is up right now. A failed request surfaces the engine's
 * own error, which beats hiding an endpoint because a health check was stale.
 */
export function providerFromEndpoint(ep: ModelEndpointMetadata): ModelProvider {
  return {
    id: ep.id,
    name: ep.name,
    source: 'endpoint',
    model: ep.model ?? '',
    baseUrl: ep.baseUrl,
    ...(ep.isMesh ? { isMesh: true } : {}),
    ...(ep.apiKeyEnc ? { hasApiKey: true } : {}),
  };
}

/**
 * Every usable provider, from both sources.
 *
 * Callers must pass lists already filtered to the requesting user — this does no ownership
 * checking of its own, deliberately, so there is exactly one place (ModelService) responsible for
 * it rather than two that can disagree.
 */
export function listProviders(
  deployments: DeploymentMetadata[],
  endpoints: ModelEndpointMetadata[] = [],
): ModelProvider[] {
  return [
    ...deployments.map(providerFromDeployment).filter((p): p is ModelProvider => p !== undefined),
    ...endpoints.map(providerFromEndpoint),
  ];
}

/**
 * Picks a provider for a request.
 *
 * Phase A routing is deliberately trivial: an explicit id wins, otherwise the first available
 * provider. Capability-based routing (context length, tool-calling, reasoning tier) needs metadata
 * no deployment records today — inventing a scoring function over fields that do not exist would
 * be guesswork dressed as intelligence.
 */
export function routeProvider(providers: ModelProvider[], requestedId?: string): ModelProvider | undefined {
  if (requestedId) return providers.find((p) => p.id === requestedId);
  return providers[0];
}
