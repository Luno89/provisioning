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

  clusterId?: string;
  namespace?: string;
  service?: string;
  port?: number;
  gpuCount?: number;
  contextTokens?: number;

  baseUrl?: string;
  isMesh?: boolean;
  hasApiKey?: boolean;
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
 * The endpoint a run reaches: what the caller asked for, else what its pack names.
 *
 * It used to return `providers[0]` when neither did, so a run silently took whichever endpoint
 * happened to be listed first and nothing recorded which. Naming nothing is now an error the
 * caller reports, not a quiet pick.
 */
export function routeProvider(
  providers: ModelProvider[],
  requestedId?: string,
  packEndpointId?: string,
): ModelProvider | undefined {
  const wanted = requestedId ?? packEndpointId;
  if (!wanted) return undefined;
  return providers.find((p) => p.id === wanted);
}
