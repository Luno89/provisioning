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
  ],
  instance: [
    'ServerOrderFollowActivity', 'ServerOrderRebuildActivity', 'ServerOrderSshActivity', 'ServerOrderDnsActivity', 'ServerOrderReleaseActivity',
    'ServerOrderBootstrapActivity', 'ServerOrderReverseDnsActivity', 'ServerOrderMailCheckActivity', 'ServerOrderStoppedActivity', 'ServerOrderFailedActivity',
    'CrawlBatchActivity', 'NextBatchActivity', 'SeedFrontierActivity', 'DiscardFrontierActivity', 'PurgeCorpusActivity', 'SearchCorpusActivity', 'NewIngestIdActivity',
  ],
};
