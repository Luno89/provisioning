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
import type { DeploymentMetadata } from './types.js';

export type ModelKind = 'vllm' | 'tabbyapi';

export interface ModelProvider {
  /** The deployment id — stable, and what the chat route takes as its model selector. */
  id: string;
  name: string;
  kind: ModelKind;
  /** What the endpoint actually serves, e.g. "meta-llama/Llama-3.1-8B". Empty if never recorded. */
  model: string;
  clusterId: string;
  /** Kubernetes namespace and Service the OpenAI-compatible API listens on. */
  namespace: string;
  service: string;
  port: number;
  gpuCount?: number;
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
    kind: dep.appType,
    model,
    clusterId: dep.clusterId,
    namespace,
    service: `${namespace}-${engine.suffix}`,
    port: engine.port,
    ...(dep.vllmGpuCount !== undefined ? { gpuCount: dep.vllmGpuCount } : {}),
  };
}

/** Every usable model provider in a deployment list, newest-looking order preserved. */
export function listProviders(deployments: DeploymentMetadata[]): ModelProvider[] {
  return deployments
    .map(providerFromDeployment)
    .filter((p): p is ModelProvider => p !== undefined);
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
