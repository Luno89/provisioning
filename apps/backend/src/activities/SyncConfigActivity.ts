import {
  StorageAdapter, buildAppEnv, envSettingsOf, modelHfToken, pushOpenWebUiWebSearchConfig, type MachineOfCluster, type Reach,
} from '../infrastructure/index.js';
import { namespacedOn, waitUntilRolledOut } from './cluster-jobs.js';
import { applyWatched } from './watched-apply.js';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';
import { appServiceType, appStackName, NO_STACK_ID, placedOnPool } from '../infrastructure/index.js';
import { ApplicationFailure } from '@temporalio/common';
import { Context } from '@temporalio/activity';
import type { AppSettings } from '../platform/index.js';

export interface SyncConfigArgs extends AppSettings {
  name: string;
  namespace?: string | undefined;
  clusterId: string;
  reach?: Reach | undefined;
  machine?: MachineOfCluster | undefined;
  clusterName: string;
  strategy: string;
  appType: string;
  webRepo?: string | undefined;
  webTag?: string | undefined;
  dbRepo?: string | undefined;
  dbTag?: string | undefined;
  storage?: Record<string, string> | undefined;
  logFile: string;
  modelCacheHostPath?: string | undefined;
  modelImage?: string | undefined;
  modelPreDownloaded?: boolean | undefined;
  deploymentId?: string | undefined;
  openaiApiBaseUrl?: string | undefined;
}

export interface SyncConfigResult {
  status: string;
  msg: string;
}


const SANITIZE = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export async function SyncConfigActivity(args: SyncConfigArgs, steps: ClusterSteps, signal?: AbortSignal): Promise<SyncConfigResult> {
  const reach = handedReach(args);
  const kubectl = (argv: string[]) => steps.access.kubectl(reach, argv);
  const logFile = args.logFile;
  const namespace = args.namespace ?? SANITIZE(args.name);

  const physicalName = args.clusterName;
  const kubeconfigPath = await steps.access.kubeconfigOf(reach);

  const storageEnv = StorageAdapter.getStorageEnv(args.appType, args.strategy, args.storage || {});
  if (!args.deploymentId) throw ApplicationFailure.nonRetryable(`${args.name} ${NO_STACK_ID}`);
  const deploymentId = args.deploymentId;

  const env = buildAppEnv({
    ...envSettingsOf(args),
    modelPreDownloaded: args.modelPreDownloaded === true,
    modelImage: args.modelImage,
    hfToken: modelHfToken(args),
    physicalName,
    strategy: args.strategy,
    namespace,
    deploymentId,
    kubeconfigPath,
    serviceType: appServiceType(placedOnPool(Boolean(steps.access.here.poolName), reach)),
    appType: args.appType,
    webRepo: args.webRepo,
    webTag: args.webTag,
    dbRepo: args.dbRepo,
    dbTag: args.dbTag,
    openaiApiBaseUrl: args.openaiApiBaseUrl,
    storageEnv,
  });

  await applyWatched(steps, appStackName(physicalName, deploymentId), { logFile, env }, { what: args.name, reach, namespaces: [namespace], signal });
  await kubectl(['rollout', 'restart', 'deployment', '-n', namespace]);

  if (args.appType === 'openwebui') {
    await waitUntilRolledOut(namespacedOn(steps.access, reach, namespace), 'deployment/open-webui', { beat: () => { try { Context.current().heartbeat(); } catch { return; } } });
    await pushOpenWebUiWebSearchConfig(kubectl, namespace, {
      ...(args.webuiEnableWebSearch !== undefined ? { enableWebSearch: args.webuiEnableWebSearch } : {}),
      ...(args.webuiWebSearchEngine !== undefined ? { webSearchEngine: args.webuiWebSearchEngine } : {}),
      ...(args.webuiWebSearchApiKey !== undefined ? { webSearchApiKey: args.webuiWebSearchApiKey } : {}),
    });
  }

  return { status: 'synced', msg: `Config synced and restart triggered for ${args.name}` };
}
