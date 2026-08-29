import { InfrastructureService } from '../services/InfrastructureService.js';
import { StorageAdapter } from '../services/StorageAdapter.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider, isSelfManagedCluster } from '../lib/cluster-topology.js';
import { buildAppEnv } from '../lib/app-env.js';
import { pushOpenWebUiWebSearchConfig } from '../lib/openwebui-admin.js';

export interface SyncConfigArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  appType: string;
  webRepo?: string | undefined;
  webTag?: string | undefined;
  dbRepo?: string | undefined;
  dbTag?: string | undefined;
  storage?: Record<string, string> | undefined;
  logFile: string;
  deploymentId?: string | undefined;
  vllmModel?: string | undefined;
  vllmGpuCount?: number | undefined;
  vllmGpuVendor?: 'nvidia' | 'amd' | undefined;
  vllmCachePvc?: string | undefined;
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
  tabbyGpuCount?: number | undefined;
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
  tabbyExtraEnv?: string | undefined;
  searxngSecretKey?: string | undefined;
  searxngEngines?: string | undefined;
  crawl4aiApiToken?: string | undefined;
  crawl4aiMemoryLimit?: string | undefined;
  crawl4aiShmSize?: string | undefined;
  openaiApiBaseUrl?: string | undefined;
  webuiEnableWebSearch?: boolean | undefined;
  webuiWebSearchEngine?: string | undefined;
  webuiWebSearchApiKey?: string | undefined;
  appSettings?: Record<string, string> | undefined;
}

export interface SyncConfigResult {
  status: string;
  msg: string;
}

export { syncConfigActivityMeta } from '../lib/activity-timeouts.js';

const SANITIZE = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export async function SyncConfigActivity(
  args: SyncConfigArgs,
): Promise<SyncConfigResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;
  const sanitizedName = SANITIZE(args.name);

  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;
  const kubeconfigPath = isSelfManagedCluster(args.provider, isMock)
    ? `/tmp/kubeconfig-${physicalName}`
    : `${process.cwd()}/.kube/config`;

  const effectiveDevice = process.env.VLLM_DEVICE || (args.vllmGpuCount === 0 ? 'cpu' : (args.vllmGpuVendor === 'amd' ? 'rocm' : 'cuda'));
  const effectiveGpuCount = args.vllmGpuCount !== undefined ? args.vllmGpuCount : 1;
  const effectiveTabbyGpuCount = args.tabbyGpuCount !== undefined ? args.tabbyGpuCount : 1;

  const storageEnv = StorageAdapter.getStorageEnv(args.appType, args.strategy, args.storage || {});
  const deploymentId = args.deploymentId || 'default';

  const env = buildAppEnv({
    physicalName,
    strategy: args.strategy,
    sanitizedName,
    deploymentId,
    kubeconfigPath,
    provider: args.provider,
    isMock,
    appType: args.appType,
    webRepo: args.webRepo,
    webTag: args.webTag,
    dbRepo: args.dbRepo,
    dbTag: args.dbTag,
    vllmModel: args.vllmModel,
    vllmGpuCount: effectiveGpuCount,
    vllmGpuVendor: args.vllmGpuVendor,
    vllmCachePvc: args.vllmCachePvc,
    vllmDevice: effectiveDevice,
    vllmHfToken: args.vllmHfToken,
    vllmMaxModelLen: args.vllmMaxModelLen,
    vllmGpuMemUtil: args.vllmGpuMemUtil,
    vllmExtraArgs: args.vllmExtraArgs,
    vllmToolCallingEnabled: args.vllmToolCallingEnabled,
    vllmToolCallParser: args.vllmToolCallParser,
    vllmServedModelName: args.vllmServedModelName,
    vllmMaxNumSeqs: args.vllmMaxNumSeqs,
    vllmDtype: args.vllmDtype,
    vllmEnablePrefixCaching: args.vllmEnablePrefixCaching,
    tabbyModel: args.tabbyModel,
    tabbyRevision: args.tabbyRevision,
    tabbyGpuCount: effectiveTabbyGpuCount,
    tabbyHfToken: args.tabbyHfToken,
    tabbyCachePvc: args.tabbyCachePvc,
    tabbyImageTag: args.tabbyImageTag,
    tabbyCacheMode: args.tabbyCacheMode,
    tabbyMaxSeqLen: args.tabbyMaxSeqLen,
    tabbyMaxBatchSize: args.tabbyMaxBatchSize,
    tabbyReasoning: args.tabbyReasoning,
    tabbyToolFormat: args.tabbyToolFormat,
    tabbyInlineModelLoading: args.tabbyInlineModelLoading,
    tabbyDisableAuth: args.tabbyDisableAuth,
    tabbyExtraEnv: args.tabbyExtraEnv,
    searxngSecretKey: args.searxngSecretKey,
    searxngEngines: args.searxngEngines,
    crawl4aiApiToken: args.crawl4aiApiToken,
    crawl4aiMemoryLimit: args.crawl4aiMemoryLimit,
    crawl4aiShmSize: args.crawl4aiShmSize,
    openaiApiBaseUrl: args.openaiApiBaseUrl,
    webuiEnableWebSearch: args.webuiEnableWebSearch,
    webuiWebSearchEngine: args.webuiWebSearchEngine,
    webuiWebSearchApiKey: args.webuiWebSearchApiKey,
    ...(args.appSettings ? { appSettings: args.appSettings } : {}),
    storageEnv,
  });

  await infra.deploy(`app-${physicalName}-${deploymentId}`, { logFile, env });

  try {
    await infra.runKubectl(['rollout', 'restart', 'deployment', '-n', sanitizedName], kubeconfigPath);
  } catch (err: any) {
    console.warn(`[SyncConfigActivity] rollout restart failed in namespace ${sanitizedName}: ${err.message}`);
  }

  if (args.appType === 'openwebui') {
    try {
      await infra.runKubectl(['rollout', 'status', 'deployment/open-webui', '-n', sanitizedName, '--timeout=120s'], kubeconfigPath);
    } catch (err: any) {
      console.warn(`[SyncConfigActivity] open-webui rollout didn't report ready within 120s: ${err.message} — attempting the config push anyway`);
    }
    await pushOpenWebUiWebSearchConfig(infra, kubeconfigPath, sanitizedName, {
      ...(args.webuiEnableWebSearch !== undefined ? { enableWebSearch: args.webuiEnableWebSearch } : {}),
      ...(args.webuiWebSearchEngine !== undefined ? { webSearchEngine: args.webuiWebSearchEngine } : {}),
      ...(args.webuiWebSearchApiKey !== undefined ? { webSearchApiKey: args.webuiWebSearchApiKey } : {}),
    });
  }

  return { status: 'synced', msg: `Config synced and restart triggered for ${args.name}` };
}
