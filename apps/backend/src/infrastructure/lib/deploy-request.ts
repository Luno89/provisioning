import type { AppSettings, DeploymentMetadata, RequestedAppSettings } from '../../platform/index.js';

type Field<K extends keyof DeploymentMetadata> = Exclude<DeploymentMetadata[K], undefined>;

export type DeployRequest = RequestedAppSettings & {
  id?: string;
  name?: string;
  namespace?: string;
  clusterId?: string;
  strategy?: Field<'strategy'>;
  appType?: string;
  modules?: string[];
  storage?: Record<string, string>;
  webRepo?: string;
  webTag?: string;
  odooRepo?: string;
  odooTag?: string;
  dbRepo?: string;
  dbTag?: string;
  pgRepo?: string;
  pgTag?: string;
  url?: string;
  openWebuiTargetId?: string;
  hermesTargetId?: string;
  gitappProjectId?: string;
  gitappImageTag?: string;
};

type Kind = 'text' | 'number' | 'flag' | 'texts' | 'textRecord' | readonly string[];

const STRATEGIES = ['helm', 'native'] as const satisfies readonly Field<'strategy'>[];
const GPU_VENDORS = ['nvidia', 'amd'] as const satisfies readonly Field<'vllmGpuVendor'>[];
const DTYPES = ['auto', 'half', 'float16', 'bfloat16', 'float', 'float32'] as const satisfies readonly Field<'vllmDtype'>[];
const CACHE_MODES = ['FP16', 'Q8', 'Q6', 'Q4'] as const satisfies readonly Field<'tabbyCacheMode'>[];
const TOOL_FORMATS = ['mistral', 'mistral_old', 'qwen3_coder', 'gemma4', 'glm4_5', 'minimax_m2', 'harmony'] as const satisfies readonly Field<'tabbyToolFormat'>[];
const SEARCH_ENGINES = ['duckduckgo', 'tavily', 'brave', 'serper', 'bing'] as const satisfies readonly Field<'webuiWebSearchEngine'>[];

const REQUESTED_SETTINGS: { [K in keyof Required<RequestedAppSettings>]: Kind } = {
  vllmModel: 'text', vllmGpuCount: 'number', vllmGpuVendor: GPU_VENDORS, vllmCachePvc: 'text', vllmHfToken: 'text',
  vllmMaxModelLen: 'number', vllmGpuMemUtil: 'number', vllmExtraArgs: 'text', vllmToolCallingEnabled: 'flag',
  vllmToolCallParser: 'text', vllmServedModelName: 'text', vllmMaxNumSeqs: 'number', vllmDtype: DTYPES,
  vllmEnablePrefixCaching: 'flag',
  tabbyModel: 'text', tabbyRevision: 'text', tabbyGpuCount: 'number', tabbyHfToken: 'text', tabbyCachePvc: 'text',
  tabbyImageTag: 'text', tabbyCacheMode: CACHE_MODES, tabbyMaxSeqLen: 'number', tabbyMaxBatchSize: 'number',
  tabbyReasoning: 'flag', tabbyToolFormat: TOOL_FORMATS, tabbyInlineModelLoading: 'flag', tabbyDisableAuth: 'flag',
  tabbyMemoryLimit: 'text', tabbyShmSize: 'text', tabbyCpuLimit: 'text', tabbyExtraEnv: 'text',
  searxngSecretKey: 'text', searxngEngines: 'text', crawl4aiApiToken: 'text', crawl4aiMemoryLimit: 'text', crawl4aiShmSize: 'text',
  gitappEnv: 'text', webuiEnableWebSearch: 'flag', webuiWebSearchEngine: SEARCH_ENGINES, webuiWebSearchApiKey: 'text', appSettings: 'textRecord',
};

export const APP_SETTINGS: { [K in keyof Required<AppSettings>]: Kind } = {
  ...REQUESTED_SETTINGS,
  minioRootUser: 'text', minioRootPassword: 'text', minioStorage: 'text',
  nextcloudAdminPassword: 'text', nextcloudDbPassword: 'text', nextcloudDbRootPassword: 'text', hermesDashboardPassword: 'text',
  verdaccioUpstream: 'text', verdaccioStorage: 'text',
};

const KINDS: { [K in keyof Required<DeployRequest>]: Kind } = {
  ...REQUESTED_SETTINGS,
  id: 'text', name: 'text', namespace: 'text', clusterId: 'text', strategy: STRATEGIES, appType: 'text',
  modules: 'texts', storage: 'textRecord',
  webRepo: 'text', webTag: 'text', odooRepo: 'text', odooTag: 'text', dbRepo: 'text', dbTag: 'text', pgRepo: 'text', pgTag: 'text', url: 'text',
  openWebuiTargetId: 'text', hermesTargetId: 'text', gitappProjectId: 'text', gitappImageTag: 'text',
};

function picked<T extends object>(keys: readonly (keyof T)[], from: T): T {
  const kept: Partial<T> = {};
  for (const key of keys) if (from[key] !== undefined) kept[key] = from[key];
  return kept as T;
}

export const appSettingsOf = (app: AppSettings): AppSettings => picked(Object.keys(APP_SETTINGS) as (keyof AppSettings)[], app);

export const requestedSettingsOf = (request: RequestedAppSettings): RequestedAppSettings => picked(Object.keys(REQUESTED_SETTINGS) as (keyof RequestedAppSettings)[], request);

export class DeployRequestProblem extends Error {
  readonly status = 400;
}

export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

export function definedFields<T extends object>(fields: T): Defined<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Defined<T>;
}

function valueOf(key: string, kind: Kind, value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (kind === 'text') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  } else if (kind === 'number') {
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  } else if (kind === 'flag') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
  } else if (kind === 'texts') {
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
  } else if (kind === 'textRecord') {
    if (typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string')) return value;
  } else if (typeof value === 'string' && kind.includes(value)) {
    return value;
  }
  const wanted = typeof kind === 'string' ? { text: 'text', number: 'a number', flag: 'true or false', texts: 'a list of text', textRecord: 'names with text values' }[kind] : `one of ${kind.join(', ')}`;
  throw new DeployRequestProblem(`${key} should be ${wanted}, not ${JSON.stringify(value)}`);
}

const NOT_A_MODEL_SERVERS = ['odooRepo', 'odooTag', 'pgRepo', 'pgTag', 'dbRepo', 'dbTag'] as const;

export function deployRequestOf(fields: Record<string, unknown>): DeployRequest {
  if (fields.appType === 'vllm' || fields.appType === 'tabbyapi') {
    const sent = NOT_A_MODEL_SERVERS.find((key) => fields[key] !== undefined && fields[key] !== null && fields[key] !== '');
    if (sent) throw new DeployRequestProblem(`a model server takes no ${sent}: its GPUs, vendor, Hugging Face token and image each have their own field`);
  }
  const request: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(KINDS) as [keyof DeployRequest, Kind][]) {
    const value = valueOf(key, kind, fields[key]);
    if (value !== undefined) request[key] = value;
  }
  return request as DeployRequest;
}
