import { describe, it, expect } from 'vitest';
import { buildAppEnv, resolveMinioDefaults, resolveNextcloudDefaults, type AppEnvArgs } from './app-env.js';
import { appTypeFromName } from './app-spec.js';
import type { DeploymentMetadata } from '../../platform/lib/types.js';

const dep = (over: Partial<DeploymentMetadata>): DeploymentMetadata => ({
  id: 'd1', name: 'x', clusterId: 'c1', status: 'running', ...over,
} as DeploymentMetadata);

describe('minting credentials before a deployment exists', () => {
  it('generates a MinIO password, because one made inside the construct is unknowable', () => {
    const out = resolveMinioDefaults(dep({ appType: 'minio' }));
    expect(out.minioRootPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(out.minioRootUser).toBe('koala');
  });

  it('keeps a password that was already stored, so a redeploy is not a lockout', () => {
    const out = resolveMinioDefaults(dep({ appType: 'minio', minioRootPassword: 'kept' }));
    expect(out.minioRootPassword).toBe('kept');
  });

  it('leaves other app types alone', () => {
    expect(resolveMinioDefaults(dep({ appType: 'mariadb' })).minioRootPassword).toBeUndefined();
  });
});

describe('the app catalog', () => {
  const knownIds = ['minio', 'qdrant', 'quickwit', 'tei', 'crawl4ai', 'odoo'];

  it('recognises a release or pod name', () => {
    expect(appTypeFromName('crawl4ai-59c75f5947', knownIds)).toBe('crawl4ai');
    expect(appTypeFromName('odoo-1', knownIds)).toBe('odoo');
    expect(appTypeFromName('nothing-here', knownIds)).toBeUndefined();
  });

  it('prefers the longest match, so a short name cannot claim a longer one', () => {
    expect(appTypeFromName('protein-service', knownIds)).not.toBe('tei');
  });
});

describe('resolveNextcloudDefaults', () => {
  it('gives a new Nextcloud its own admin and database passwords, never a fixed one, and keeps them once set', () => {
    const first = resolveNextcloudDefaults(dep({ appType: 'nextcloud' }));
    const second = resolveNextcloudDefaults(dep({ appType: 'nextcloud' }));
    expect(first.nextcloudAdminPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(first.nextcloudAdminPassword).not.toBe(second.nextcloudAdminPassword);
    expect(first.nextcloudDbPassword).not.toBe(first.nextcloudDbRootPassword);
    expect(resolveNextcloudDefaults(first)).toEqual(first);
    expect(resolveNextcloudDefaults(dep({ appType: 'minio' })).nextcloudAdminPassword).toBeUndefined();
  });
});

describe('the environment a deploy hands its stack', () => {
  const base: AppEnvArgs = { serviceType: 'ClusterIP', physicalName: 'desk', strategy: 'helm', namespace: 'shop-1a2b', deploymentId: 'd1', kubeconfigPath: '/k/config', appType: 'odoo', storageEnv: {} };

  it('names the app, where it goes and how, under the names the stack reads', () => {
    expect(buildAppEnv(base)).toMatchObject({ STACK_TYPE: 'app', CLUSTER_NAME: 'desk', DEPLOYMENT_STRATEGY: 'helm', DEPLOYMENT_NAME: 'shop-1a2b', DEPLOYMENT_ID: 'd1', KUBECONFIG: '/k/config', APP_SERVICE_TYPE: 'ClusterIP', APP_TYPE: 'odoo' });
  });

  it('hands over the images a deploy asked for, to the web and database sides alike', () => {
    expect(buildAppEnv({ ...base, webRepo: 'reg/odoo', webTag: '17.0', dbRepo: 'reg/postgres', dbTag: '16' })).toMatchObject({
      WEB_IMAGE_REPO: 'reg/odoo', WEB_IMAGE_TAG: '17.0', DB_IMAGE_REPO: 'reg/postgres', DB_IMAGE_TAG: '16',
      ODOO_IMAGE_REPO: 'reg/odoo', ODOO_IMAGE_TAG: '17.0', POSTGRES_IMAGE_REPO: 'reg/postgres', POSTGRES_IMAGE_TAG: '16',
    });
  });

  it('hands over every vLLM setting a deploy asked for, as the stack reads it', () => {
    const env = buildAppEnv({ ...base, appType: 'vllm', vllmModel: 'org/model', vllmGpuCount: 2, vllmGpuVendor: 'nvidia', vllmCachePvc: 'models', modelPreDownloaded: true, modelImage: 'vllm/vllm-openai:v1', hfToken: 'hf-token', vllmMaxModelLen: 8192, vllmGpuMemUtil: 0.85, vllmExtraArgs: '--seed 1', vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes', vllmServedModelName: 'mine', vllmMaxNumSeqs: 16, vllmDtype: 'bfloat16', vllmEnablePrefixCaching: true });
    expect(env).toMatchObject({
      VLLM_MODEL: 'org/model', VLLM_GPU_COUNT: '2', VLLM_GPU_VENDOR: 'nvidia', VLLM_CACHE_PVC: 'models', VLLM_MODEL_PREDOWNLOADED: 'true', MODEL_IMAGE: 'vllm/vllm-openai:v1', HF_TOKEN: 'hf-token',
      VLLM_MAX_MODEL_LEN: '8192', VLLM_GPU_MEM_UTIL: '0.85', VLLM_EXTRA_ARGS: '--seed 1', VLLM_TOOL_CALLING_ENABLED: 'true', VLLM_TOOL_CALL_PARSER: 'hermes', VLLM_SERVED_MODEL_NAME: 'mine',
      VLLM_MAX_NUM_SEQS: '16', VLLM_DTYPE: 'bfloat16', VLLM_ENABLE_PREFIX_CACHING: 'true',
    });
  });

  it('hands over every TabbyAPI setting a deploy asked for, as the stack reads it', () => {
    const env = buildAppEnv({ ...base, appType: 'tabbyapi', tabbyModel: 'org/exl', tabbyRevision: 'main', tabbyGpuCount: 1, tabbyModelSizeBytes: 4_000_000_000, tabbyCachePvc: 'tabby', tabbyCacheMode: 'Q8', tabbyMaxSeqLen: 16384, tabbyMaxBatchSize: 4, tabbyReasoning: true, tabbyToolFormat: 'qwen3_coder', tabbyInlineModelLoading: true, tabbyDisableAuth: false, tabbyMemoryLimit: '24Gi', tabbyShmSize: '2Gi', tabbyCpuLimit: '4', tabbyExtraEnv: 'A=1' });
    expect(env).toMatchObject({
      TABBYAPI_MODEL: 'org/exl', TABBYAPI_REVISION: 'main', TABBYAPI_GPU_COUNT: '1', TABBYAPI_MODEL_SIZE_BYTES: '4000000000', TABBYAPI_CACHE_PVC: 'tabby', TABBYAPI_CACHE_MODE: 'Q8',
      TABBYAPI_MAX_SEQ_LEN: '16384', TABBYAPI_MAX_BATCH_SIZE: '4', TABBYAPI_REASONING: 'true', TABBYAPI_TOOL_FORMAT: 'qwen3_coder', TABBYAPI_INLINE_MODEL_LOADING: 'true', TABBYAPI_DISABLE_AUTH: 'false',
      TABBYAPI_MEMORY_LIMIT: '24Gi', TABBYAPI_SHM_SIZE: '2Gi', TABBYAPI_CPU_LIMIT: '4', TABBYAPI_EXTRA_ENV: 'A=1',
    });
  });

  it('hands the stack its empty or off value for each setting a deploy left out, and leaves a GPU count out entirely rather than saying zero', () => {
    const env = buildAppEnv(base);
    expect(env).toMatchObject({
      WEB_IMAGE_REPO: '', WEB_IMAGE_TAG: '', DB_IMAGE_REPO: '', DB_IMAGE_TAG: '', VPN_ENABLED: 'false', VPN_PROTOCOL: 'wireguard', VPN_CONFIG: '', VPN_DEDICATED_IP: '',
      VLLM_MODEL: '', VLLM_GPU_VENDOR: '', VLLM_MODEL_PREDOWNLOADED: 'false', HF_TOKEN: '', VLLM_MAX_MODEL_LEN: '', VLLM_GPU_MEM_UTIL: '', VLLM_TOOL_CALLING_ENABLED: 'false', VLLM_ENABLE_PREFIX_CACHING: 'false',
      TABBYAPI_REASONING: 'false', TABBYAPI_INLINE_MODEL_LOADING: 'false', TABBYAPI_DISABLE_AUTH: 'true', WEBUI_ENABLE_WEB_SEARCH: '', APP_SETTINGS_JSON: '{}', APP_SPEC_JSON: '',
    });
    expect(env).not.toHaveProperty('VLLM_GPU_COUNT');
    expect(env).not.toHaveProperty('TABBYAPI_GPU_COUNT');
  });

  it('hands over the other apps\' settings, the app\'s own settings and its storage', () => {
    const env = buildAppEnv({ ...base, appType: 'searxng', searxngSecretKey: 'sx', searxngEngines: 'ddg', crawl4aiApiToken: 'c4', crawl4aiMemoryLimit: '2Gi', crawl4aiShmSize: '1Gi', minioRootUser: 'root', minioRootPassword: 'mp', nextcloudAdminPassword: 'na', nextcloudDbPassword: 'nd', nextcloudDbRootPassword: 'nr', hermesDashboardPassword: 'hp', minioStorage: '10Gi', verdaccioUpstream: 'https://registry.npmjs.org', verdaccioStorage: '2Gi', gitappEnv: 'A=1', openaiApiBaseUrl: 'http://llm/v1', webuiEnableWebSearch: false, webuiWebSearchEngine: 'brave', webuiWebSearchApiKey: 'wk', appSettings: { theme: 'dark' }, renderedSpec: { kind: 'x' } as never, bindingsJson: '[]', storageEnv: { STORAGE_DATA: '20Gi' } });
    expect(env).toMatchObject({
      SEARXNG_SECRET_KEY: 'sx', SEARXNG_ENGINES: 'ddg', CRAWL4AI_API_TOKEN: 'c4', CRAWL4AI_MEMORY_LIMIT: '2Gi', CRAWL4AI_SHM_SIZE: '1Gi', MINIO_ROOT_USER: 'root', MINIO_ROOT_PASSWORD: 'mp',
      NEXTCLOUD_ADMIN_PASSWORD: 'na', NEXTCLOUD_DB_PASSWORD: 'nd', NEXTCLOUD_DB_ROOT_PASSWORD: 'nr', HERMES_DASHBOARD_PASSWORD: 'hp', MINIO_STORAGE: '10Gi',
      VERDACCIO_UPSTREAM: 'https://registry.npmjs.org', VERDACCIO_STORAGE: '2Gi', GITAPP_ENV: 'A=1', OPENAI_API_BASE_URL: 'http://llm/v1', WEBUI_ENABLE_WEB_SEARCH: 'false',
      WEBUI_WEB_SEARCH_ENGINE: 'brave', WEBUI_WEB_SEARCH_API_KEY: 'wk', APP_SETTINGS_JSON: '{"theme":"dark"}', APP_SPEC_JSON: '{"kind":"x"}', BINDINGS_JSON: '[]', STORAGE_DATA: '20Gi',
    });
  });
});

describe('the defaults a deploy fills in, held to their exact values', () => {
  it('keeps each password a Nextcloud already has, the database ones as much as the admin one, so a redeploy is not a lockout', () => {
    const stored = dep({ appType: 'nextcloud', nextcloudAdminPassword: 'admin-kept', nextcloudDbPassword: 'db-kept', nextcloudDbRootPassword: 'root-kept' });
    expect(resolveNextcloudDefaults(stored)).toMatchObject({ nextcloudAdminPassword: 'admin-kept', nextcloudDbPassword: 'db-kept', nextcloudDbRootPassword: 'root-kept' });
    const partly = resolveNextcloudDefaults(dep({ appType: 'nextcloud', nextcloudDbPassword: 'db-kept' }));
    expect(partly.nextcloudDbPassword).toBe('db-kept');
    expect(partly.nextcloudDbRootPassword).toMatch(/^[0-9a-f]{48}$/);
  });

  it('hands the stack an empty value for every setting a deploy left out, never some other text', () => {
    const asked = new Set(['STACK_TYPE', 'CLUSTER_NAME', 'DEPLOYMENT_STRATEGY', 'DEPLOYMENT_NAME', 'DEPLOYMENT_ID', 'KUBECONFIG', 'APP_SERVICE_TYPE', 'APP_TYPE', 'VPN_ENABLED', 'VPN_PROTOCOL', 'VLLM_MODEL_PREDOWNLOADED', 'VLLM_TOOL_CALLING_ENABLED', 'VLLM_ENABLE_PREFIX_CACHING', 'TABBYAPI_REASONING', 'TABBYAPI_INLINE_MODEL_LOADING', 'TABBYAPI_DISABLE_AUTH', 'APP_SETTINGS_JSON']);
    const left = Object.entries(buildAppEnv({ serviceType: 'ClusterIP', physicalName: 'desk', strategy: 'helm', namespace: 'shop-1a2b', deploymentId: 'd1', kubeconfigPath: '/k/config', appType: 'odoo', storageEnv: {} })).filter(([name]) => !asked.has(name));
    expect(left.length).toBeGreaterThan(50);
    expect(left.filter(([, value]) => value !== '')).toEqual([]);
  });
});

