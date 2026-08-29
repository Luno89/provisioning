import { clusterUrl } from './cluster-dns.js';

export interface LlmAppSpec {
  readonly appType: string;
  readonly label: string;
  readonly serviceSuffix: string;
  readonly port: number;
  readonly apiPath: string;
  readonly modelField: 'vllmModel' | 'tabbyModel';
  readonly contextField?: 'vllmMaxModelLen' | 'tabbyMaxSeqLen';
}

export const LLM_APPS: readonly LlmAppSpec[] = [
  {
    appType: 'vllm',
    label: 'vLLM',
    serviceSuffix: 'vllm',
    port: 8000,
    apiPath: '/v1',
    modelField: 'vllmModel',
    contextField: 'vllmMaxModelLen',
  },
  {
    appType: 'tabbyapi',
    label: 'TabbyAPI',
    serviceSuffix: 'tabbyapi',
    port: 5000,
    apiPath: '/v1',
    modelField: 'tabbyModel',
    contextField: 'tabbyMaxSeqLen',
  },
];

const BY_APP_TYPE = new Map(LLM_APPS.map((spec) => [spec.appType, spec]));

export function llmAppSpec(appType: string | undefined): LlmAppSpec | undefined {
  return appType ? BY_APP_TYPE.get(appType) : undefined;
}

export function isLlmApp(appType: string | undefined): boolean {
  return llmAppSpec(appType) !== undefined;
}

export function inClusterBaseUrl(spec: LlmAppSpec, namespace: string): string {
  return clusterUrl(
    { service: `${namespace}-${spec.serviceSuffix}`, namespace, port: spec.port },
    { path: spec.apiPath },
  );
}

export interface LlmApiTag {
  readonly port: number;
  readonly serviceSuffix?: string;
  readonly apiPath?: string;
  readonly model?: string;
}

export function specFromTag(tag: LlmApiTag, appType: string): LlmAppSpec | undefined {
  if (!Number.isInteger(tag.port) || tag.port < 1 || tag.port > 65535) return undefined;
  return {
    appType,
    label: 'Custom',
    serviceSuffix: tag.serviceSuffix || appType,
    port: tag.port,
    apiPath: tag.apiPath || '/v1',
    modelField: 'vllmModel',
  };
}
