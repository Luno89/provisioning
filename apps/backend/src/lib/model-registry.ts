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
import { llmAppSpec, specFromTag } from './llm-apps.js';

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
  /**
   * The context window the engine was started with, when the platform deployed it and so knows.
   *
   * Absent for a registered endpoint, whose length nobody recorded — callers fall back to
   * `FALLBACK_CONTEXT_TOKENS`. Absent is honest here; a guess would be the same class of mistake as
   * the constant this replaces.
   */
  contextTokens?: number;

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

export function isModelKind(appType: string | undefined): appType is ModelKind {
  return appType === 'vllm' || appType === 'tabbyapi';
}

/**
 * Returns undefined for anything that is not a usable model endpoint — an app type that serves no
 * OpenAI API and carries no llmApi tag, or one that is not running yet. A deploying or failed
 * endpoint would accept a port-forward and then hang, so it is excluded here rather than
 * discovered as a timeout at request time.
 *
 * The catalogue (lib/llm-apps.ts) is consulted FIRST and wins: for an app type the platform
 * packages, the platform's own service name and port are authoritative and no stored field can
 * override them. The `llmApi` tag is only an escape hatch for app types the catalogue does not
 * cover — a gitapp the user built that happens to serve an OpenAI-compatible API.
 */
export function providerFromDeployment(dep: DeploymentMetadata): ModelProvider | undefined {
  if (dep.status !== 'running') return undefined;

  const spec = llmAppSpec(dep.appType) ?? (dep.llmApi ? specFromTag(dep.llmApi, dep.appType ?? 'custom') : undefined);
  if (!spec) return undefined;

  const namespace = sanitizeNamespace(dep.name);
  if (!namespace) return undefined;

  // Catalogue entries name the field that records the served model; a tagged deployment supplies
  // it inline, since there is no first-class field for an app type the platform does not package.
  const model = (llmAppSpec(dep.appType) ? dep[spec.modelField] : dep.llmApi?.model) ?? '';

  return {
    id: dep.id,
    name: dep.name,
    source: 'deployment',
    ...(isModelKind(dep.appType) ? { kind: dep.appType } : {}),
    model,
    clusterId: dep.clusterId,
    namespace,
    service: `${namespace}-${spec.serviceSuffix}`,
    port: spec.port,
    ...(dep.vllmGpuCount !== undefined ? { gpuCount: dep.vllmGpuCount } : {}),
    // Only for a catalogued engine: a tagged `llmApi` deployment has no field recording its window,
    // and inventing one would put every budget back on a number nobody checked.
    ...(() => {
      const catalogued = llmAppSpec(dep.appType);
      const window = catalogued?.contextField ? dep[catalogued.contextField] : undefined;
      return typeof window === 'number' && window > 0 ? { contextTokens: window } : {};
    })(),
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
