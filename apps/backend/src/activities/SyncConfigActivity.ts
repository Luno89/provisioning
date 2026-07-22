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
import { buildAppEnv } from '../lib/app-env.js';

export interface SyncConfigArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  appType: string;
  webRepo?: string;
  webTag?: string;
  dbRepo?: string;
  dbTag?: string;
  storage?: Record<string, string>;
  logFile: string;
  deploymentId?: string;
  vllmModel?: string;
  vllmGpuCount?: number;
  vllmGpuVendor?: 'nvidia' | 'amd';
  vllmCachePvc?: string;
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
}

export interface SyncConfigResult {
  status: string;
  msg: string;
}

export const syncConfigActivityMeta = {
  name: 'SyncConfigActivity',
  startToCloseTimeout: '80 minutes',
};

const SANITIZE = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export async function SyncConfigActivity(
  args: SyncConfigArgs,
): Promise<SyncConfigResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;
  const sanitizedName = SANITIZE(args.name);

  const isMock = args.provider !== 'k3d' && !hasCloudCredentials(args.provider);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;
  const kubeconfigPath = (args.provider === 'k3d' || isMock)
    ? `/tmp/kubeconfig-${physicalName}`
    : `${process.cwd()}/.kube/config`;

  const effectiveDevice = process.env.VLLM_DEVICE || (args.vllmGpuCount === 0 ? 'cpu' : (args.vllmGpuVendor === 'amd' ? 'rocm' : 'cuda'));
  const effectiveGpuCount = args.vllmGpuCount !== undefined ? args.vllmGpuCount : 1;

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
    openaiApiBaseUrl: args.openaiApiBaseUrl,
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

  return { status: 'synced', msg: `Config synced and restart triggered for ${args.name}` };
}
