/**
 * Builds the CDKTF AppStack env vars (see packages/cdktf-infra/main.ts) from already-resolved
 * deployment values. Shared by DeployAppActivity (first deploy) and SyncConfigActivity (re-apply
 * an existing deployment's current config) so the two can never drift out of sync on env var names.
 */
import type { DeploymentMetadata } from './types.js';

export interface AppEnvArgs {
  physicalName: string;
  strategy: string;
  sanitizedName: string;
  deploymentId: string;
  kubeconfigPath: string;
  provider: string;
  isMock: boolean;
  appType: string;
  webRepo?: string;
  webTag?: string;
  dbRepo?: string;
  dbTag?: string;
  vllmModel?: string;
  vllmGpuCount: number;
  vllmGpuVendor?: 'nvidia' | 'amd';
  vllmCachePvc?: string;
  vllmDevice: string;
  vllmHfToken?: string;
  vllmMaxModelLen?: number;
  vllmGpuMemUtil?: number;
  vllmExtraArgs?: string;
  vllmToolCallingEnabled?: boolean;
  vllmToolCallParser?: string;
  vllmServedModelName?: string;
  vllmMaxNumSeqs?: number;
  vllmDtype?: string;
  vllmEnablePrefixCaching?: boolean;
  openaiApiBaseUrl?: string;
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

export function buildAppEnv(a: AppEnvArgs): Record<string, string> {
  return {
    STACK_TYPE: 'app',
    CLUSTER_NAME: a.physicalName,
    DEPLOYMENT_STRATEGY: a.strategy,
    DEPLOYMENT_NAME: a.sanitizedName,
    DEPLOYMENT_ID: a.deploymentId,
    KUBECONFIG: a.kubeconfigPath,
    KUBECONFIG_CONTEXT: (a.provider === 'k3d' || a.isMock) ? `k3d-${a.physicalName}` : '',
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
    HF_TOKEN: a.vllmHfToken || process.env.HF_TOKEN || '',
    VLLM_MAX_MODEL_LEN: a.vllmMaxModelLen !== undefined ? String(a.vllmMaxModelLen) : '',
    VLLM_GPU_MEM_UTIL: a.vllmGpuMemUtil !== undefined ? String(a.vllmGpuMemUtil) : '',
    VLLM_EXTRA_ARGS: a.vllmExtraArgs || '',
    VLLM_TOOL_CALLING_ENABLED: a.vllmToolCallingEnabled ? 'true' : 'false',
    VLLM_TOOL_CALL_PARSER: a.vllmToolCallParser || '',
    VLLM_SERVED_MODEL_NAME: a.vllmServedModelName || '',
    VLLM_MAX_NUM_SEQS: a.vllmMaxNumSeqs !== undefined ? String(a.vllmMaxNumSeqs) : '',
    VLLM_DTYPE: a.vllmDtype || '',
    VLLM_ENABLE_PREFIX_CACHING: a.vllmEnablePrefixCaching ? 'true' : 'false',
    OPENAI_API_BASE_URL: a.openaiApiBaseUrl || '',
    ...a.storageEnv,
  };
}
