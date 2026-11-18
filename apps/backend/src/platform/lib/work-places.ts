import type { PlatformRole } from './platform-role.js';

export const QUEUES = {
  engine: 'engine-queue',
  stream: 'engine-stream-queue',
  cluster: 'cluster-ops-queue',
  host: 'host-ops-queue',
} as const;

export type Place = keyof typeof QUEUES;

export const queueOf = (place: Place): string => QUEUES[place];

const PLACES: Record<PlatformRole, readonly Place[]> = {
  root: ['host'],
  instance: ['engine', 'stream', 'cluster', 'host'],
  hub: [],
};

export const placesOf = (role: PlatformRole): readonly Place[] => PLACES[role];

export const roleRuns = (role: PlatformRole, place: Place): boolean => PLACES[role].includes(place);

export const HOST_ACTIVITIES: Record<'root' | 'instance', readonly string[]> = {
  root: [
    'PoolHostActivity', 'PoolVclusterActivity', 'PoolProxyActivity', 'PoolChartActivity', 'PoolReadyActivity', 'PoolFailedActivity',
    'PoolTrialNextActivity', 'PoolTrialStepActivity', 'PoolRemoveActivity', 'PoolMoveStartActivity', 'PoolMoveSwitchActivity', 'PoolMoveStopActivity',
    'DependencyWatchActivity',
    'RootRemovalInstanceActivity', 'RootRemovalMeshActivity', 'RootRemovalRecordsActivity',
    'KoalaInstallAskActivity', 'KoalaInstallStageActivity',
  ],
  instance: [
    'ServerOrderFollowActivity', 'ServerOrderRebuildActivity', 'ServerOrderSshActivity', 'ServerOrderDnsActivity', 'ServerOrderReleaseActivity',
    'ServerOrderBootstrapActivity', 'ServerOrderReverseDnsActivity', 'ServerOrderMailCheckActivity', 'ServerOrderStoppedActivity', 'ServerOrderFailedActivity',
    'CrawlBatchActivity', 'NextBatchActivity', 'SeedFrontierActivity', 'DiscardFrontierActivity', 'PurgeCorpusActivity', 'NewIngestIdActivity',
  ],
};

type Started = { place: Place; roles: readonly PlatformRole[] };

const onRoot = (place: Place): Started => ({ place, roles: ['root'] });
const onInstance = (place: Place): Started => ({ place, roles: ['instance'] });

export const WORKFLOWS: Record<string, Started> = {
  DependencyWatchWorkflow: onRoot('host'),
  PoolInstanceWorkflow: onRoot('host'),
  PoolTrialWorkflow: onRoot('host'),
  PoolRemoveWorkflow: onRoot('host'),
  PoolMoveWorkflow: onRoot('host'),
  RootAccountRemovalWorkflow: onRoot('host'),
  KoalaInstallWorkflow: onRoot('host'),
  executeIngestWorkflow: onInstance('host'),
  RootNodeWorkflow: onInstance('host'),
  executeDeployAppWorkflow: onInstance('cluster'),
  executeDestroyAppWorkflow: onInstance('cluster'),
  executeResizeDiskWorkflow: onInstance('cluster'),
  executeSyncConfigWorkflow: onInstance('cluster'),
  executePipelineRunWorkflow: onInstance('cluster'),
  ProvisionPieceWorkflow: onInstance('cluster'),
  AgentRunWorkflow: onInstance('engine'),
  AdoptPlanWorkflow: onInstance('engine'),
  ConversationConclusionWorkflow: onInstance('engine'),
  BenchIdleWorkflow: onInstance('engine'),
  ConcludeWorkspaceWorkflow: onInstance('engine'),
  RemoveAccountWorkflow: onInstance('engine'),
  RemoveProjectWorkflow: onInstance('engine'),
  CheckRunWorkflow: onInstance('engine'),
  StoredFilesWorkflow: onInstance('engine'),
  StoredFilesSweepWorkflow: onInstance('engine'),
};
