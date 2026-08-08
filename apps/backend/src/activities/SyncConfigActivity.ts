/**
 * SyncConfigActivity
 *
 * Re-applies an EXISTING deployment's currently-stored config via CDKTF (no image
 * build/import — that's what DeployAppActivity/updateModules are for), then forces a rollout
 * restart. The CDKTF apply alone only restarts pods when the pod spec actually changed (e.g.
 * new env vars); the explicit rollout restart guarantees pods come back up even when nothing
 * in the spec differs — useful to recover a stuck pod or just confirm current config is live.
 */
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

// Moved to lib/activity-timeouts.ts — see that file for why (workflow files must never import a
// VALUE from an activity file, only `import type`).
export { syncConfigActivityMeta } from '../lib/activity-timeouts.js';

const SANITIZE = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export async function SyncConfigActivity(
  args: SyncConfigArgs,
): Promise<SyncConfigResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;
  const sanitizedName = SANITIZE(args.name);

  // See DeployAppActivity.ts's identical comment — 'remote' is never a mock-cloud scenario.
  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;
  // See DeployAppActivity.ts's identical comment — 'remote' clusters also use this exact path.
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

  // Re-apply the same CDKTF stack this deployment was originally created with — if the config
  // actually changed (e.g. edited Advanced args), Kubernetes sees a new pod template hash and
  // rolls out new pods on its own; if nothing changed, this is a no-op apply.
  await infra.deploy(`app-${physicalName}-${deploymentId}`, { logFile, env });

  // Force the restart regardless, so "Sync Config & Restart" always actually restarts — matches
  // kubectl's own annotation-bump trick under the hood (patches spec.template.metadata.annotations
  // to force a new ReplicaSet). Bare `deployment` (no name) rather than a guessed Deployment name
  // because each app construct names its Deployment resource differently (e.g. vllm.ts: "<ns>-vllm",
  // odoo-native: "odoo", audiobookshelf-native: "audiobookshelf") — kubectl's own doc example for
  // this is exactly "kubectl rollout restart deployment -n <namespace>" to restart every
  // Deployment in that namespace at once; there's no `--all` flag (verified against `--help`).
  try {
    await infra.runKubectl(['rollout', 'restart', 'deployment', '-n', sanitizedName], kubeconfigPath);
  } catch (err: any) {
    console.warn(`[SyncConfigActivity] rollout restart failed in namespace ${sanitizedName}: ${err.message}`);
  }

  // CDKTF env vars only ever seed Open WebUI's own persisted config on a pod's first-ever boot;
  // an already-running instance ignores them, so push the actual change through its Admin API.
  if (args.appType === 'openwebui') {
    // The rollout restart above is unconditional (always forces a new pod, even when nothing
    // Kubernetes-visible actually changed), so pushOpenWebUiWebSearchConfig below would otherwise
    // race it — `kubectl exec deployment/open-webui` can land on a pod whose Open WebUI process
    // hasn't finished booting yet (not listening on 8080), silently failing the whole push since
    // it's best-effort by design. Confirmed live: this raced and silently failed even with
    // correct env vars and a real admin user already present. Wait for the new pod to actually
    // be Ready first — "open-webui" is a fixed name (see constructs/open-webui.ts), unlike the
    // generic `deployment` (no name) used for the restart above, which has to stay
    // app-type-agnostic since every construct names its Deployment differently.
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
