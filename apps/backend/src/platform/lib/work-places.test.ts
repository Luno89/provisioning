import { describe, expect, it } from 'vitest';
import { HOST_ACTIVITIES, QUEUES, placesOf, queueOf, roleRuns } from './work-places.js';

describe('where work runs', () => {
  it('names each place\'s queue once', () => {
    expect(QUEUES).toEqual({ engine: 'engine-queue', stream: 'engine-stream-queue', cluster: 'cluster-ops-queue', host: 'host-ops-queue' });
    expect(queueOf('cluster')).toBe('cluster-ops-queue');
  });

  it('runs root\'s own work on root, every place on an instance, and nothing on the hub', () => {
    expect(placesOf('root')).toEqual(['host']);
    expect(placesOf('instance')).toEqual(['engine', 'stream', 'cluster', 'host']);
    expect(placesOf('hub')).toEqual([]);
    expect(roleRuns('root', 'cluster')).toBe(false);
    expect(roleRuns('instance', 'cluster')).toBe(true);
  });

  it('gives root\'s host worker the pool, root\'s removals and the dependency watch, and an instance\'s its server orders and the crawl, none of them both', () => {
    expect(HOST_ACTIVITIES.root).toEqual(expect.arrayContaining(['PoolHostActivity', 'PoolRemoveActivity', 'RootRemovalRecordsActivity', 'DependencyWatchActivity']));
    expect(HOST_ACTIVITIES.instance).toEqual(expect.arrayContaining(['ServerOrderFollowActivity', 'CrawlBatchActivity', 'NewIngestIdActivity']));
    expect(HOST_ACTIVITIES.root.filter((activity) => HOST_ACTIVITIES.instance.includes(activity))).toEqual([]);
  });
});
