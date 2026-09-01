import type { DeploymentMetadata, ModelEndpointMetadata } from './types.js';
import { llmAppSpec, specFromTag } from './llm-apps.js';

export type ModelKind = 'vllm' | 'tabbyapi';

export type ModelSource = 'deployment' | 'endpoint';

export interface ModelProvider {
  id: string;
  name: string;
  source: ModelSource;
  kind?: ModelKind;
  model: string;
  /** Human label for where the model came from — vLLM, TabbyAPI, OpenRouter, etc. */
  sourceLabel?: string;

  clusterId?: string;
  namespace?: string;
  service?: string;
  port?: number;
  gpuCount?: number;
  contextTokens?: number;

  baseUrl?: string;
  isMesh?: boolean;
  hasApiKey?: boolean;
  /** Dollars per million tokens. Absent for a deployment — you pay for the box, not the token. */
  pricing?: { promptPerMTok: number; completionPerMTok: number };
  /** Artificial Analysis Intelligence Index, when their catalogue matched this model. */
  intelligence?: number;
}

export function sanitizeNamespace(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function isModelKind(appType: string | undefined): appType is ModelKind {
  return appType === 'vllm' || appType === 'tabbyapi';
}

export function providerFromDeployment(dep: DeploymentMetadata): ModelProvider | undefined {
  if (dep.status !== 'running') return undefined;

  const spec = llmAppSpec(dep.appType) ?? (dep.llmApi ? specFromTag(dep.llmApi, dep.appType ?? 'custom') : undefined);
  if (!spec) return undefined;

  const namespace = sanitizeNamespace(dep.name);
  if (!namespace) return undefined;

  const model = (llmAppSpec(dep.appType) ? dep[spec.modelField] : dep.llmApi?.model) ?? '';

  return {
    id: dep.id,
    name: dep.name,
    source: 'deployment',
    ...(isModelKind(dep.appType) ? { kind: dep.appType } : {}),
    ...(spec.label ? { sourceLabel: spec.label } : {}),
    model,
    clusterId: dep.clusterId,
    namespace,
    service: `${namespace}-${spec.serviceSuffix}`,
    port: spec.port,
    ...(dep.vllmGpuCount !== undefined ? { gpuCount: dep.vllmGpuCount } : {}),
    ...(() => {
      const catalogued = llmAppSpec(dep.appType);
      const window = catalogued?.contextField ? dep[catalogued.contextField] : undefined;
      return typeof window === 'number' && window > 0 ? { contextTokens: window } : {};
    })(),
  };
}

export function providerFromEndpoint(ep: ModelEndpointMetadata): ModelProvider {
  return {
    id: ep.id,
    name: ep.name,
    source: 'endpoint',
    model: ep.model ?? '',
    baseUrl: ep.baseUrl,
    ...(ep.name.includes(' · ')
      ? { sourceLabel: ep.name.split(' · ')[0]! }
      : { sourceLabel: 'Custom' }),
    ...(ep.contextTokens ? { contextTokens: ep.contextTokens } : {}),
    ...(ep.pricing ? { pricing: ep.pricing } : {}),
    ...(ep.intelligence !== undefined ? { intelligence: ep.intelligence } : {}),
    ...(ep.isMesh ? { isMesh: true } : {}),
    ...(ep.apiKeyEnc ? { hasApiKey: true } : {}),
  };
}

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
 * Which layer named the endpoint a run reached. Recorded on the run; see `AgentRequest.ranAs`.
 *
 * `sole` is not a named layer and is not decided here — it is `ModelService`'s "an account with one
 * endpoint has nothing to choose between" exception, which is the only place a provider is reached
 * without something naming it.
 */
export type EndpointSource = 'request' | 'pack' | 'global' | 'sole';

export interface RoutedProvider {
  provider: ModelProvider;
  source: EndpointSource;
}

/**
 * The endpoint a run reaches: what the caller asked for, else what its pack names, else the
 * account's default.
 *
 * It used to return `providers[0]` when neither of the first two did, so a run silently took
 * whichever endpoint happened to be listed first and nothing recorded which. Naming nothing is
 * still an error the caller reports, not a quiet pick — the account default added here is a named
 * setting, not a fallback to whatever was listed first, and `source` says which layer won so the
 * run can record it.
 */
export interface RouteOptions {
  /**
   * Make the account default beat what a pack names, instead of the other way round.
   *
   * A flag rather than writing the default into every pack: a pack's own engine is left intact, so
   * turning this back off returns each one to what it named. Overwriting the packs would make the
   * change one-way.
   */
  overrideGlobal?: boolean | undefined;
}

export function routeProvider(
  providers: ModelProvider[],
  requestedId?: string | null,
  packEndpointId?: string | null,
  globalEndpointId?: string | null,
  options: RouteOptions = {},
): RoutedProvider | undefined {
  const preference: [string | null | undefined, EndpointSource][] = options.overrideGlobal
    ? [[globalEndpointId, 'global'], [packEndpointId, 'pack']]
    : [[packEndpointId, 'pack'], [globalEndpointId, 'global']];

  // An explicit ask always wins: it is a per-turn choice, not a standing setting.
  const layers: [string | null | undefined, EndpointSource][] = [
    [requestedId, 'request'],
    ...preference,
  ];
  for (const [wanted, source] of layers) {
    if (!wanted) continue;
    const provider = providers.find((p) => p.id === wanted);
    return provider ? { provider, source } : undefined;
  }
  return undefined;
}
