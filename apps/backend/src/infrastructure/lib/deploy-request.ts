import type { DeploymentMetadata } from '../../platform/index.js';

type Field<K extends keyof DeploymentMetadata> = Exclude<DeploymentMetadata[K], undefined>;

export type DeployRequest = {
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
  vllmModel?: string;
  vllmGpuCount?: number;
  vllmGpuVendor?: Field<'vllmGpuVendor'>;
  vllmCachePvc?: string;
  vllmHfToken?: string;
  vllmMaxModelLen?: number;
  vllmGpuMemUtil?: number;
  vllmExtraArgs?: string;
  vllmToolCallingEnabled?: boolean;
  vllmToolCallParser?: Field<'vllmToolCallParser'>;
  vllmServedModelName?: string;
  vllmMaxNumSeqs?: number;
  vllmDtype?: Field<'vllmDtype'>;
  vllmEnablePrefixCaching?: boolean;
  tabbyModel?: string;
  tabbyRevision?: string;
  tabbyGpuCount?: number;
  tabbyHfToken?: string;
  tabbyCachePvc?: string;
  tabbyImageTag?: string;
  tabbyCacheMode?: Field<'tabbyCacheMode'>;
  tabbyMaxSeqLen?: number;
  tabbyMaxBatchSize?: number;
  tabbyReasoning?: boolean;
  tabbyToolFormat?: Field<'tabbyToolFormat'>;
  tabbyInlineModelLoading?: boolean;
  tabbyDisableAuth?: boolean;
  tabbyMemoryLimit?: string;
  tabbyShmSize?: string;
  tabbyCpuLimit?: string;
  tabbyExtraEnv?: string;
  searxngSecretKey?: string;
  searxngEngines?: string;
  crawl4aiApiToken?: string;
  crawl4aiMemoryLimit?: string;
  crawl4aiShmSize?: string;
  openWebuiTargetId?: string;
  hermesTargetId?: string;
  webuiEnableWebSearch?: boolean;
  webuiWebSearchEngine?: Field<'webuiWebSearchEngine'>;
  webuiWebSearchApiKey?: string;
  appSettings?: Record<string, string>;
  gitappProjectId?: string;
  gitappImageTag?: string;
  gitappEnv?: string;
};

type Kind = 'text' | 'number' | 'flag' | 'texts' | 'textRecord' | readonly string[];

const STRATEGIES = ['helm', 'native'] as const satisfies readonly Field<'strategy'>[];
const GPU_VENDORS = ['nvidia', 'amd'] as const satisfies readonly Field<'vllmGpuVendor'>[];
const TOOL_CALL_PARSERS = ['granite-20b-fc', 'granite', 'hermes', 'internlm', 'jamba', 'llama3_json', 'mistral', 'pythonic'] as const satisfies readonly Field<'vllmToolCallParser'>[];
const DTYPES = ['auto', 'half', 'float16', 'bfloat16', 'float', 'float32'] as const satisfies readonly Field<'vllmDtype'>[];
const CACHE_MODES = ['FP16', 'Q8', 'Q6', 'Q4'] as const satisfies readonly Field<'tabbyCacheMode'>[];
const TOOL_FORMATS = ['mistral', 'mistral_old', 'qwen3_coder', 'gemma4', 'glm4_5', 'minimax_m2', 'harmony'] as const satisfies readonly Field<'tabbyToolFormat'>[];
const SEARCH_ENGINES = ['duckduckgo', 'tavily', 'brave', 'serper', 'bing'] as const satisfies readonly Field<'webuiWebSearchEngine'>[];

const KINDS: { [K in keyof Required<DeployRequest>]: Kind } = {
  id: 'text', name: 'text', namespace: 'text', clusterId: 'text', strategy: STRATEGIES, appType: 'text',
  modules: 'texts', storage: 'textRecord',
  webRepo: 'text', webTag: 'text', odooRepo: 'text', odooTag: 'text', dbRepo: 'text', dbTag: 'text', pgRepo: 'text', pgTag: 'text', url: 'text',
  vllmModel: 'text', vllmGpuCount: 'number', vllmGpuVendor: GPU_VENDORS, vllmCachePvc: 'text', vllmHfToken: 'text',
  vllmMaxModelLen: 'number', vllmGpuMemUtil: 'number', vllmExtraArgs: 'text', vllmToolCallingEnabled: 'flag',
  vllmToolCallParser: TOOL_CALL_PARSERS, vllmServedModelName: 'text', vllmMaxNumSeqs: 'number', vllmDtype: DTYPES,
  vllmEnablePrefixCaching: 'flag',
  tabbyModel: 'text', tabbyRevision: 'text', tabbyGpuCount: 'number', tabbyHfToken: 'text', tabbyCachePvc: 'text',
  tabbyImageTag: 'text', tabbyCacheMode: CACHE_MODES, tabbyMaxSeqLen: 'number', tabbyMaxBatchSize: 'number',
  tabbyReasoning: 'flag', tabbyToolFormat: TOOL_FORMATS, tabbyInlineModelLoading: 'flag', tabbyDisableAuth: 'flag',
  tabbyMemoryLimit: 'text', tabbyShmSize: 'text', tabbyCpuLimit: 'text', tabbyExtraEnv: 'text',
  searxngSecretKey: 'text', searxngEngines: 'text', crawl4aiApiToken: 'text', crawl4aiMemoryLimit: 'text', crawl4aiShmSize: 'text',
  openWebuiTargetId: 'text', hermesTargetId: 'text', webuiEnableWebSearch: 'flag', webuiWebSearchEngine: SEARCH_ENGINES,
  webuiWebSearchApiKey: 'text', appSettings: 'textRecord', gitappProjectId: 'text', gitappImageTag: 'text', gitappEnv: 'text',
};

export class DeployRequestProblem extends Error {}

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

export function deployRequestOf(fields: Record<string, unknown>): DeployRequest {
  const request: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(KINDS) as [keyof DeployRequest, Kind][]) {
    const value = valueOf(key, kind, fields[key]);
    if (value !== undefined) request[key] = value;
  }
  return request as DeployRequest;
}
