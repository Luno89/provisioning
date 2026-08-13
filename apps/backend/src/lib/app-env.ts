/**
 * Builds the CDKTF AppStack env vars (see packages/cdktf-infra/main.ts) from already-resolved
 * deployment values. Shared by DeployAppActivity (first deploy) and SyncConfigActivity (re-apply
 * an existing deployment's current config) so the two can never drift out of sync on env var names.
 */
import { randomBytes } from 'node:crypto';
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
  // Real byte count from HuggingFace's file-tree API (see DeployAppActivity.ts), when the lookup
  // succeeded — lets tabbyapi.ts size /dev/shm and the memory limit off the actual model instead
  // of its own regex-based guess from the repo name, which it falls back to when this is absent.
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
  openaiApiBaseUrl?: string | undefined;
  webuiEnableWebSearch?: boolean | undefined;
  webuiWebSearchEngine?: string | undefined;
  webuiWebSearchApiKey?: string | undefined;
  // Schema-driven settings for game servers etc. Serialized as one JSON env var rather than ~120
  // discrete ones, so main.ts needs a single read instead of 120 named ones.
  appSettings?: Record<string, string> | undefined;
  storageEnv: Record<string, string>;
}

// Keep in sync with packages/cdktf-infra/constructs/vllm.ts's own fallback defaults
// (modelName/gpuCount/gpuVendor) — those are the values that actually get deployed whenever a
// vLLM app is created without explicitly setting them. Not sharable as a real cross-package
// import today, but resolving the SAME concrete values here — before persisting to Mongo —
// means the stored deployment record (and therefore the Config tab) always reflects what's
// actually running instead of silently leaving the field blank while vllm.ts substitutes a
// default no one ever wrote back.
export const VLLM_DEFAULT_MODEL = 'meta-llama/Llama-3.2-3B-Instruct';
export const VLLM_DEFAULT_GPU_COUNT = 1;
export const VLLM_DEFAULT_GPU_VENDOR: 'nvidia' | 'amd' = 'nvidia';

// Keep in sync with packages/cdktf-infra/constructs/tabbyapi.ts's own fallback default (model) —
// see resolveVllmDefaults above for why this is resolved here rather than left to tabbyapi.ts.
// Defaults below mirror a known-working config.yml (turboderp/Qwen3.6-27B-exl3, Q8 KV cache,
// 262144 max_seq_len, tensor parallel across 2 GPUs, reasoning + qwen3_coder tool format).
export const TABBYAPI_DEFAULT_MODEL = 'turboderp/Qwen3.6-27B-exl3';
export const TABBYAPI_DEFAULT_GPU_COUNT = 2;
export const TABBYAPI_DEFAULT_CACHE_MODE: 'FP16' | 'Q8' | 'Q6' | 'Q4' = 'Q8';
/**
 * 32K, not 256K.
 *
 * Measured: at 262144 this model held ~27 GiB of VRAM for a KV cache nothing used, and the host
 * memory plan correctly REFUSES that configuration on a 30 GiB node. Dropping to 32768 freed 7.7
 * GiB of VRAM with no observed cost — the harness clips conversation messages at 6,000 characters
 * and tool results at 8,000, so nothing here comes close to the old ceiling.
 */
export const TABBYAPI_DEFAULT_MAX_SEQ_LEN = 32768;
export const TABBYAPI_DEFAULT_REASONING = true;
export const TABBYAPI_DEFAULT_TOOL_FORMAT = 'qwen3_coder';
/**
 * Off.
 *
 * Inline loading keeps a host-side copy of the weights so a model can be swapped without re-reading
 * it — worth paying only if you actually swap models. Measured on the same deployment: 21.4 GiB of
 * host RAM with it on, 7.8 GiB with it off, identical VRAM either way. On by default it left a
 * 30 GiB machine with 244 MiB free and 8.6 GiB swapped.
 */
export const TABBYAPI_DEFAULT_INLINE_MODEL_LOADING = false;

/**
 * Mints the Crawl4AI credential HERE rather than letting the construct generate one.
 *
 * The construct can generate a token, and if it does nothing else ever learns it — the agent needs
 * the same secret to call the service, and reading it back out of a Kubernetes Secret at tool-call
 * time is a round trip that can fail on a path that has no way to report it. Resolving it before
 * the record is persisted means the deployment stores what it deployed, which is the same reason
 * `resolveVllmDefaults` resolves model names here instead of leaving them to vllm.ts.
 *
 * Not optional: with no token the image's entrypoint binds loopback and refuses to expose itself,
 * so a Service in front of it never answers.
 */
export function resolveCrawl4aiDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  if (dep.appType !== 'crawl4ai') return dep;
  return Object.assign({}, dep, {
    crawl4aiApiToken: dep.crawl4aiApiToken || randomBytes(32).toString('hex'),
  });
}

/** Same reasoning as `resolveCrawl4aiDefaults` — a key generated in the construct is unknowable. */
export function resolveSearxngDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  if (dep.appType !== 'searxng') return dep;
  return Object.assign({}, dep, {
    searxngSecretKey: dep.searxngSecretKey || randomBytes(32).toString('hex'),
  });
}

/** Credentials for the two search services that hold data of their own. */
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

/**
 * Quickwit's credentials, which are not its own.
 *
 * Its metastore and every index split live in the MinIO bucket, so it has to be handed the keys
 * that MinIO was actually deployed with. Generating a fresh pair here — the shape every other
 * resolver above has — would produce a pod that starts, passes its liveness probe, and cannot read
 * a single split.
 *
 * Hence the deployment list: this is the one resolver that reads another deployment's record, and
 * it fails loudly when there is nothing to read rather than deploying something inert.
 */
export function resolveQuickwitDefaults(
  dep: DeploymentMetadata,
  deployments: DeploymentMetadata[],
): DeploymentMetadata {
  if (dep.appType !== 'quickwit') return dep;

  const minio = deployments.find((d) =>
    d.appType === 'minio' && d.status === 'running' && (!dep.ownerId || !d.ownerId || d.ownerId === dep.ownerId));

  if (!minio?.minioRootPassword && !dep.quickwitS3SecretKey) {
    throw new Error(
      'Quickwit keeps its indexes in MinIO, so a running MinIO deployment is required before it can '
      + 'be deployed. Deploy minio first.',
    );
  }

  return Object.assign({}, dep, {
    quickwitBucket: dep.quickwitBucket || 'koala-corpus',
    quickwitS3AccessKey: dep.quickwitS3AccessKey || minio?.minioRootUser || 'koala',
    quickwitS3SecretKey: dep.quickwitS3SecretKey || minio?.minioRootPassword || '',
    quickwitS3Endpoint: dep.quickwitS3Endpoint
      // The in-cluster Service address, not an ingress: this is pod-to-pod and must not depend on
      // an ingress controller or a port-forward being up.
      || `http://minio.${minio?.name ?? 'minio'}.svc.cluster.local:9000`,
  });
}

// Not generic on purpose — every caller in this codebase passes a real DeploymentMetadata, and
// a generic here fights TypeScript's control-flow narrowing at call sites where `dep` starts as
// `DeploymentMetadata | undefined` (destructured from a filter()) and gets reassigned just
// before this call.
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
    // Distinct from KUBECONFIG_CONTEXT above: that one selects a real kubeconfig context (must
    // stay empty for 'remote', whose kubeconfig has no "k3d-..." context to select). This tells
    // every app construct's serviceType heuristic whether it's targeting a self-managed k3s
    // cluster (no real cloud LB controller — a `LoadBalancer` Service just hangs forever waiting
    // for an external IP, or on k3s's own ServiceLB, conflicts with Traefik's hostPort claim).
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
    OPENAI_API_BASE_URL: a.openaiApiBaseUrl || '',
    // Empty string (not 'true'/'false') when unset, not a default value baked in here — lets
    // main.ts's own `=== 'false'` check (and the construct's `!== false` default-true beneath
    // it) be the single source of truth for "enabled unless explicitly disabled" instead of
    // this layer silently overriding it either direction.
    WEBUI_ENABLE_WEB_SEARCH: a.webuiEnableWebSearch === false ? 'false' : '',
    WEBUI_WEB_SEARCH_ENGINE: a.webuiWebSearchEngine || '',
    WEBUI_WEB_SEARCH_API_KEY: a.webuiWebSearchApiKey || '',
    APP_SETTINGS_JSON: JSON.stringify(a.appSettings ?? {}),
    ...a.storageEnv,
  };
}
