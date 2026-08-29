import { randomBytes } from 'node:crypto';
import { clusterUrl } from './cluster-dns.js';
import type { DeploymentMetadata } from './types.js';
import { isSelfManagedCluster } from './cluster-topology.js';

export interface AppEnvArgs {
  physicalName: string;
  strategy: string;
  sanitizedName: string;
  deploymentId: string;
  kubeconfigPath: string;
  provider: string;
  isMock: boolean;
  appType: string;
  renderedSpec?: unknown;
  bindingsJson?: string | undefined;
  webRepo?: string | undefined;
  webTag?: string | undefined;
  dbRepo?: string | undefined;
  dbTag?: string | undefined;
  vllmModel?: string | undefined;
  vllmGpuCount: number;
  vllmGpuVendor?: 'nvidia' | 'amd' | undefined;
  vllmCachePvc?: string | undefined;
  vllmDevice: string;
  vllmHfToken?: string | undefined;
  vllmMaxModelLen?: number | undefined;
  vllmGpuMemUtil?: number | undefined;
  vllmExtraArgs?: string | undefined;
  vllmToolCallingEnabled?: boolean | undefined;
  vllmToolCallParser?: string | undefined;
  vllmServedModelName?: string | undefined;
  vllmMaxNumSeqs?: number | undefined;
  vllmDtype?: string | undefined;
  vllmEnablePrefixCaching?: boolean | undefined;
  tabbyModel?: string | undefined;
  tabbyRevision?: string | undefined;
  tabbyGpuCount: number;
  tabbyModelSizeBytes?: number | undefined;
  tabbyHfToken?: string | undefined;
  tabbyCachePvc?: string | undefined;
  tabbyImageTag?: string | undefined;
  tabbyCacheMode?: string | undefined;
  tabbyMaxSeqLen?: number | undefined;
  tabbyMaxBatchSize?: number | undefined;
  tabbyReasoning?: boolean | undefined;
  tabbyToolFormat?: string | undefined;
  tabbyInlineModelLoading?: boolean | undefined;
  tabbyDisableAuth?: boolean | undefined;
  tabbyMemoryLimit?: string | undefined;
  tabbyShmSize?: string | undefined;
  tabbyCpuLimit?: string | undefined;
  tabbyExtraEnv?: string | undefined;
  searxngSecretKey?: string | undefined;
  searxngEngines?: string | undefined;
  crawl4aiApiToken?: string | undefined;
  crawl4aiMemoryLimit?: string | undefined;
  crawl4aiShmSize?: string | undefined;
  minioRootUser?: string | undefined;
  minioRootPassword?: string | undefined;
  minioStorage?: string | undefined;
  qdrantApiKey?: string | undefined;
  qdrantStorage?: string | undefined;
  qdrantMemoryLimit?: string | undefined;
  quickwitS3Endpoint?: string | undefined;
  quickwitS3AccessKey?: string | undefined;
  quickwitS3SecretKey?: string | undefined;
  quickwitBucket?: string | undefined;
  teiModelId?: string | undefined;
  teiUseGpu?: boolean | undefined;
  teiMemoryLimit?: string | undefined;
  verdaccioUpstream?: string | undefined;
  verdaccioStorage?: string | undefined;
  gitappEnv?: string | undefined;
  openaiApiBaseUrl?: string | undefined;
  webuiEnableWebSearch?: boolean | undefined;
  webuiWebSearchEngine?: string | undefined;
  webuiWebSearchApiKey?: string | undefined;
  appSettings?: Record<string, string> | undefined;
  storageEnv: Record<string, string>;
}

export const VLLM_DEFAULT_MODEL = 'meta-llama/Llama-3.2-3B-Instruct';
export const VLLM_DEFAULT_GPU_COUNT = 1;
export const VLLM_DEFAULT_GPU_VENDOR: 'nvidia' | 'amd' = 'nvidia';

export const TABBYAPI_DEFAULT_MODEL = 'turboderp/Qwen3.6-27B-exl3';
export const TABBYAPI_DEFAULT_GPU_COUNT = 2;
export const TABBYAPI_DEFAULT_CACHE_MODE: 'FP16' | 'Q8' | 'Q6' | 'Q4' = 'Q8';
export const TABBYAPI_DEFAULT_MAX_SEQ_LEN = 32768;
export const TABBYAPI_DEFAULT_REASONING = true;
export const TABBYAPI_DEFAULT_TOOL_FORMAT = 'qwen3_coder';
export const TABBYAPI_DEFAULT_INLINE_MODEL_LOADING = false;

export function resolveCrawl4aiDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  if (dep.appType !== 'crawl4ai') return dep;
  return Object.assign({}, dep, {
    crawl4aiApiToken: dep.crawl4aiApiToken || randomBytes(32).toString('hex'),
  });
}

export function resolveSearxngDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  if (dep.appType !== 'searxng') return dep;
  return Object.assign({}, dep, {
    searxngSecretKey: dep.searxngSecretKey || randomBytes(32).toString('hex'),
  });
}

export function resolveMinioDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  if (dep.appType !== 'minio') return dep;
  return Object.assign({}, dep, {
    minioRootUser: dep.minioRootUser || 'koala',
    minioRootPassword: dep.minioRootPassword || randomBytes(24).toString('hex'),
  });
}

export function resolveQdrantDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  if (dep.appType !== 'qdrant') return dep;
  return Object.assign({}, dep, {
    qdrantApiKey: dep.qdrantApiKey || randomBytes(32).toString('hex'),
  });
}

export function resolveQuickwitDefaults(
  dep: DeploymentMetadata,
  deployments: DeploymentMetadata[],
): DeploymentMetadata {
  if (dep.appType !== 'quickwit') return dep;

  const GONE = new Set(['destroying', 'destroyed', 'failed']);
  const minio = deployments.find((d) =>
    d.appType === 'minio'
    && !GONE.has(d.status)
    && Boolean(d.minioRootPassword)
    && (!dep.ownerId || !d.ownerId || d.ownerId === dep.ownerId));

  if (!minio && !dep.quickwitS3SecretKey) {
    const anyMinio = deployments.some((d) => d.appType === 'minio' && !GONE.has(d.status));
    throw new Error(
      anyMinio
        ? 'A MinIO deployment exists but its root credentials are not stored, so Quickwit cannot be '
          + 'given keys for it. Redeploy minio so the credentials are minted and persisted.'
        : 'Quickwit keeps its indexes in MinIO, so a MinIO deployment is required before it can be '
          + 'deployed. Deploy minio first.',
    );
  }

  return Object.assign({}, dep, {
    quickwitBucket: dep.quickwitBucket || 'koala-corpus',
    quickwitS3AccessKey: dep.quickwitS3AccessKey || minio?.minioRootUser || 'koala',
    quickwitS3SecretKey: dep.quickwitS3SecretKey || minio?.minioRootPassword || '',
    quickwitS3Endpoint: dep.quickwitS3Endpoint
      || clusterUrl({ service: 'minio', namespace: minio?.name ?? 'minio', port: 9000 }),
  });
}

export function resolveVllmDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  if (dep.appType !== 'vllm') return dep;
  return Object.assign({}, dep, {
    vllmModel: dep.vllmModel || VLLM_DEFAULT_MODEL,
    vllmGpuCount: dep.vllmGpuCount !== undefined ? dep.vllmGpuCount : VLLM_DEFAULT_GPU_COUNT,
    vllmGpuVendor: dep.vllmGpuVendor || VLLM_DEFAULT_GPU_VENDOR,
  });
}

export function resolveTabbyDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  if (dep.appType !== 'tabbyapi') return dep;
  return Object.assign({}, dep, {
    tabbyModel: dep.tabbyModel || TABBYAPI_DEFAULT_MODEL,
    tabbyGpuCount: dep.tabbyGpuCount !== undefined ? dep.tabbyGpuCount : TABBYAPI_DEFAULT_GPU_COUNT,
    tabbyCacheMode: dep.tabbyCacheMode || TABBYAPI_DEFAULT_CACHE_MODE,
    tabbyMaxSeqLen: dep.tabbyMaxSeqLen !== undefined ? dep.tabbyMaxSeqLen : TABBYAPI_DEFAULT_MAX_SEQ_LEN,
    tabbyReasoning: dep.tabbyReasoning !== undefined ? dep.tabbyReasoning : TABBYAPI_DEFAULT_REASONING,
    tabbyToolFormat: dep.tabbyToolFormat || TABBYAPI_DEFAULT_TOOL_FORMAT,
    tabbyInlineModelLoading: dep.tabbyInlineModelLoading !== undefined ? dep.tabbyInlineModelLoading : TABBYAPI_DEFAULT_INLINE_MODEL_LOADING,
  });
}

export function buildAppEnv(a: AppEnvArgs): Record<string, string> {
  return {
    STACK_TYPE: 'app',
    CLUSTER_NAME: a.physicalName,
    DEPLOYMENT_STRATEGY: a.strategy,
    DEPLOYMENT_NAME: a.sanitizedName,
    DEPLOYMENT_ID: a.deploymentId,
    KUBECONFIG: a.kubeconfigPath,
    KUBECONFIG_CONTEXT: (a.provider === 'k3d' || a.isMock) ? `k3d-${a.physicalName}` : '',
    SELF_MANAGED_K8S: isSelfManagedCluster(a.provider, a.isMock) ? 'true' : 'false',
    APP_TYPE: a.appType,
    WEB_IMAGE_REPO: a.webRepo || '',
    WEB_IMAGE_TAG: a.webTag || '',
    DB_IMAGE_REPO: a.dbRepo || '',
    DB_IMAGE_TAG: a.dbTag || '',
    VPN_ENABLED: 'false',
    VPN_PROTOCOL: 'wireguard',
    VPN_CONFIG: '',
    VPN_DEDICATED_IP: '',
    ODOO_IMAGE_REPO: a.webRepo || '',
    ODOO_IMAGE_TAG: a.webTag || '',
    POSTGRES_IMAGE_REPO: a.dbRepo || '',
    POSTGRES_IMAGE_TAG: a.dbTag || '',
    VLLM_MODEL: a.vllmModel || '',
    VLLM_GPU_COUNT: String(a.vllmGpuCount),
    VLLM_GPU_VENDOR: a.vllmGpuVendor || 'nvidia',
    VLLM_CACHE_PVC: a.vllmCachePvc || '',
    VLLM_IMAGE_TAG: (a.webTag && a.webTag !== 'latest') ? a.webTag : 'v0.7.2',
    VLLM_DEVICE: a.vllmDevice,
    VLLM_HF_TOKEN: a.vllmHfToken || process.env.HF_TOKEN || '',
    HF_TOKEN: a.vllmHfToken || a.tabbyHfToken || process.env.HF_TOKEN || '',
    VLLM_MAX_MODEL_LEN: a.vllmMaxModelLen !== undefined ? String(a.vllmMaxModelLen) : '',
    VLLM_GPU_MEM_UTIL: a.vllmGpuMemUtil !== undefined ? String(a.vllmGpuMemUtil) : '',
    VLLM_EXTRA_ARGS: a.vllmExtraArgs || '',
    VLLM_TOOL_CALLING_ENABLED: a.vllmToolCallingEnabled ? 'true' : 'false',
    VLLM_TOOL_CALL_PARSER: a.vllmToolCallParser || '',
    VLLM_SERVED_MODEL_NAME: a.vllmServedModelName || '',
    VLLM_MAX_NUM_SEQS: a.vllmMaxNumSeqs !== undefined ? String(a.vllmMaxNumSeqs) : '',
    VLLM_DTYPE: a.vllmDtype || '',
    VLLM_ENABLE_PREFIX_CACHING: a.vllmEnablePrefixCaching ? 'true' : 'false',
    TABBYAPI_MODEL: a.tabbyModel || '',
    TABBYAPI_REVISION: a.tabbyRevision || '',
    TABBYAPI_GPU_COUNT: String(a.tabbyGpuCount),
    TABBYAPI_MODEL_SIZE_BYTES: a.tabbyModelSizeBytes !== undefined ? String(a.tabbyModelSizeBytes) : '',
    TABBYAPI_HF_TOKEN: a.tabbyHfToken || process.env.HF_TOKEN || '',
    TABBYAPI_CACHE_PVC: a.tabbyCachePvc || '',
    TABBYAPI_IMAGE_TAG: a.tabbyImageTag || 'latest',
    TABBYAPI_CACHE_MODE: a.tabbyCacheMode || '',
    TABBYAPI_MAX_SEQ_LEN: a.tabbyMaxSeqLen !== undefined ? String(a.tabbyMaxSeqLen) : '',
    TABBYAPI_MAX_BATCH_SIZE: a.tabbyMaxBatchSize !== undefined ? String(a.tabbyMaxBatchSize) : '',
    TABBYAPI_REASONING: a.tabbyReasoning ? 'true' : 'false',
    TABBYAPI_TOOL_FORMAT: a.tabbyToolFormat || '',
    TABBYAPI_INLINE_MODEL_LOADING: a.tabbyInlineModelLoading ? 'true' : 'false',
    TABBYAPI_DISABLE_AUTH: a.tabbyDisableAuth === false ? 'false' : 'true',
    TABBYAPI_MEMORY_LIMIT: a.tabbyMemoryLimit || '',
    TABBYAPI_SHM_SIZE: a.tabbyShmSize || '',
    TABBYAPI_CPU_LIMIT: a.tabbyCpuLimit || '',
    TABBYAPI_EXTRA_ENV: a.tabbyExtraEnv || '',
    SEARXNG_SECRET_KEY: a.searxngSecretKey || '',
    SEARXNG_ENGINES: a.searxngEngines || '',
    CRAWL4AI_API_TOKEN: a.crawl4aiApiToken || '',
    CRAWL4AI_MEMORY_LIMIT: a.crawl4aiMemoryLimit || '',
    CRAWL4AI_SHM_SIZE: a.crawl4aiShmSize || '',
    MINIO_ROOT_USER: a.minioRootUser || '',
    MINIO_ROOT_PASSWORD: a.minioRootPassword || '',
    MINIO_STORAGE: a.minioStorage || '',
    QDRANT_API_KEY: a.qdrantApiKey || '',
    QDRANT_STORAGE: a.qdrantStorage || '',
    QDRANT_MEMORY_LIMIT: a.qdrantMemoryLimit || '',
    QUICKWIT_S3_ENDPOINT: a.quickwitS3Endpoint || '',
    QUICKWIT_S3_ACCESS_KEY: a.quickwitS3AccessKey || '',
    QUICKWIT_S3_SECRET_KEY: a.quickwitS3SecretKey || '',
    QUICKWIT_BUCKET: a.quickwitBucket || '',
    TEI_MODEL_ID: a.teiModelId || '',
    TEI_USE_GPU: a.teiUseGpu === true ? 'true' : '',
    TEI_MEMORY_LIMIT: a.teiMemoryLimit || '',
    VERDACCIO_UPSTREAM: a.verdaccioUpstream || '',
    VERDACCIO_STORAGE: a.verdaccioStorage || '',
    GITAPP_ENV: a.gitappEnv || '',
    OPENAI_API_BASE_URL: a.openaiApiBaseUrl || '',
    WEBUI_ENABLE_WEB_SEARCH: a.webuiEnableWebSearch === false ? 'false' : '',
    WEBUI_WEB_SEARCH_ENGINE: a.webuiWebSearchEngine || '',
    WEBUI_WEB_SEARCH_API_KEY: a.webuiWebSearchApiKey || '',
    APP_SETTINGS_JSON: JSON.stringify(a.appSettings ?? {}),
    APP_SPEC_JSON: a.renderedSpec ? JSON.stringify(a.renderedSpec) : '',
    BINDINGS_JSON: a.bindingsJson || '',
    ...a.storageEnv,
  };
}
