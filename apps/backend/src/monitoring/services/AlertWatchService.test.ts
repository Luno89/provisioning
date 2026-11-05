import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { asPerson, principalOf } from '../../platform/lib/permissions.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import { RULE_LABEL, alertSpec, type AlertSpec, type PromAlert } from '../lib/monitoring-alerts.js';
import type { AlertEpisode } from '../lib/monitoring-records.js';
import { AlertWatchService, HISTORY_RETRY_MS, WATCH_EVERY_MS, type AlertWatchDeps } from './AlertWatchService.js';
import type { MetricsClient } from './MonitoringService.js';

const ME = principalOf({ id: 'me' }, { role: 'instance', instanceOwnerId: 'me' });
const system = { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true } as ClusterMetadata;
const other = { id: 'c-other', name: 'other', provider: 'hetzner', status: 'healthy', ownerId: 'me' } as ClusterMetadata;

const dep = (fields: Partial<DeploymentMetadata> & { id: string; name: string }): DeploymentMetadata =>
  ({ clusterId: system.id, strategy: 'native', appType: 'audiobookshelf', ownerId: 'me', status: 'running', createdAt: 'then', ...fields }) as DeploymentMetadata;

let db: Database;
let metrics: MockProxy<MetricsClient>;
let monitoring: MockProxy<AlertWatchDeps['monitoring']>;
let told: string[];
let logged: string[];
let clock: Date;
let ids: number;

const watcher = (extra: Partial<AlertWatchDeps> = {}) => new AlertWatchService({
  monitoring,
  store: db,
  people: async () => [ME],
  tell: async (episode: AlertEpisode, change) => { told.push(`${episode.ownerId} ${change} ${episode.summary}`); },
  log: (message) => { logged.push(message); },
  now: () => clock,
  newId: () => `ep-${ids++}`,
  ...extra,
});

beforeEach(async () => {
  db = memoryDatabase();
  told = [];
  logged = [];
  ids = 0;
  clock = new Date('2026-10-17T12:00:00Z');
  metrics = mock<MetricsClient>();
  metrics.alerts.mockResolvedValue([]);
  monitoring = mock<AlertWatchDeps['monitoring']>();
  monitoring.allClusters.mockResolvedValue([system]);
  monitoring.reach.mockResolvedValue({ cluster: system, state: 'ok', metrics });
  monitoring.syncPoolProbes.mockResolvedValue(undefined);
  monitoring.applyHistory.mockResolvedValue(false);
  monitoring.applyRequestMetrics.mockResolvedValue('already');
  await db.infrastructure.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
  await db.infrastructure.saveDeploymentInfo(dep({ id: 'theirs', name: 'Theirs', namespace: 'theirs', ownerId: 'someone' }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('watching alerts', () => {
  it('tells each person once when their alert fires, and again when it resolves', async () => {
    const watch = watcher();
    const firing: PromAlert[] = [
      { labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing', activeAt: '2026-10-17T11:58:00Z' },
      { labels: { alertname: 'AppProbeDown', namespace: 'theirs' }, state: 'firing' },
      { labels: { alertname: 'NodeMemoryHighUtilization', instance: 'n1' }, state: 'firing' },
      { labels: { alertname: 'Watchdog' }, state: 'firing' },
    ];
    metrics.alerts.mockResolvedValue(firing);
    await watch.tick();
    await watch.tick();
    expect(told.sort()).toEqual(['me fired Books is not answering', 'me fired Memory is nearly full', 'someone fired Theirs is not answering']);
    expect((await db.monitoring.getAlertEpisodes('me')).find((episode) => episode.summary === 'Books is not answering')?.startedAt).toBe('2026-10-17T11:58:00Z');

    metrics.alerts.mockResolvedValue([]);
    await watch.tick();
    expect(told.filter((line) => line.includes('resolved')).sort()).toEqual(['me resolved Books is not answering', 'me resolved Memory is nearly full', 'someone resolved Theirs is not answering']);
    expect((await db.monitoring.getAlertEpisodes('me')).every((episode) => episode.resolvedAt === clock.toISOString())).toBe(true);
  });

  it('tells only the rule\'s owner about it, with the rule and its app', async () => {
    await db.monitoring.saveAlertRule({ id: 'r1', ownerId: 'me', deploymentId: 'books', clusterId: system.id, namespace: 'books', appName: 'Books', spec: alertSpec('down') as AlertSpec, summary: 'Books: down', createdAt: 'then' });
    metrics.alerts.mockResolvedValue([{ labels: { alertname: 'Koala_down', namespace: 'books', [RULE_LABEL]: 'r1' }, annotations: { summary: 'Books: down' }, state: 'firing' }]);
    const tell = vi.fn<AlertWatchDeps['tell']>().mockResolvedValue(undefined);
    await watcher({ tell }).tick();
    expect(tell).toHaveBeenCalledTimes(1);
    expect(tell.mock.calls[0]?.[0]).toMatchObject({ ownerId: 'me', ruleId: 'r1', summary: 'Books: down' });
    expect(tell.mock.calls[0]?.[1]).toBe('fired');
    expect(tell.mock.calls[0]?.[2].rule?.id).toBe('r1');
    expect(tell.mock.calls[0]?.[2].app?.id).toBe('books');
  });

  it('tells a machine alert without an app or a rule', async () => {
    metrics.alerts.mockResolvedValue([{ labels: { alertname: 'NodeMemoryHighUtilization', instance: 'n1' }, state: 'firing' }]);
    const tell = vi.fn<AlertWatchDeps['tell']>().mockResolvedValue(undefined);
    await watcher({ tell }).tick();
    expect(tell.mock.calls[0]?.[2]).toEqual({ app: undefined, rule: undefined });
  });

  it('keeps an episode open while its cluster\'s alerts cannot be read, and says so', async () => {
    const watch = watcher();
    metrics.alerts.mockResolvedValue([{ labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing' }]);
    await watch.tick();
    metrics.alerts.mockRejectedValue(new Error('down'));
    await watch.tick();
    expect(told.filter((line) => line.includes('resolved'))).toEqual([]);
    expect(logged).toContain('[alerts] provisioning-lunorica: its alerts could not be read, so none are opened or resolved this pass (down)');
  });

  it('skips a cluster with no metrics', async () => {
    monitoring.reach.mockResolvedValue({ cluster: system, state: 'unreachable', reason: 'it is down' });
    await watcher().tick();
    expect(monitoring.syncPoolProbes).not.toHaveBeenCalled();
    expect(told).toEqual([]);
  });

  it('ignores an app being destroyed', async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books', status: 'destroying' }));
    metrics.alerts.mockResolvedValue([{ labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing' }]);
    await watcher().tick();
    expect(told).toEqual([]);
  });

  it('tells someone who is not among the people it is given as the app\'s owner', async () => {
    metrics.alerts.mockResolvedValue([{ labels: { alertname: 'AppProbeDown', namespace: 'theirs' }, state: 'firing' }]);
    await watcher({ people: async () => [] }).tick();
    expect(told).toEqual(['someone fired Theirs is not answering']);
  });

  it('logs when telling someone fails and goes on', async () => {
    metrics.alerts.mockResolvedValue([{ labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing' }]);
    await watcher({ tell: async () => { throw new Error('mail is down'); } }).tick();
    expect(logged).toContain('[alerts] could not tell me: mail is down');
    expect(await db.monitoring.getAlertEpisodes('me')).toHaveLength(1);
  });

  it('logs a pass that fails and runs the next one', async () => {
    monitoring.allClusters.mockRejectedValueOnce(new Error('store is gone'));
    const watch = watcher();
    await watch.tick();
    expect(logged).toEqual(['[alerts] store is gone']);
    metrics.alerts.mockResolvedValue([{ labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing' }]);
    await watch.tick();
    expect(told).toEqual(['me fired Books is not answering']);
  });

  it('shares one pass between callers that ask while it runs', async () => {
    const watch = watcher();
    const first = watch.tick();
    expect(watch.tick()).toBe(first);
    await first;
    expect(monitoring.allClusters).toHaveBeenCalledTimes(1);
  });

  it('says when it could not hand the probes to Koala\'s servers and carries on', async () => {
    monitoring.syncPoolProbes.mockRejectedValue(new Error('root is away'));
    metrics.alerts.mockResolvedValue([{ labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing' }]);
    await watcher().tick();
    expect(logged).toContain('[alerts] provisioning-lunorica: its probes were not handed to Koala\'s servers (root is away)');
    expect(told).toEqual(['me fired Books is not answering']);
  });

  it('watches every cluster it is given', async () => {
    const remoteMetrics = mock<MetricsClient>();
    remoteMetrics.alerts.mockResolvedValue([{ labels: { alertname: 'AppProbeDown', namespace: 'erp' }, state: 'firing' }]);
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'erp', name: 'ERP', namespace: 'erp', clusterId: other.id }));
    monitoring.allClusters.mockResolvedValue([system, other]);
    monitoring.reach.mockImplementation(async (cluster) => ({ cluster, state: 'ok', metrics: cluster.id === other.id ? remoteMetrics : metrics }));
    await watcher().tick();
    expect(told).toEqual(['me fired ERP is not answering']);
  });
});

describe('keeping a cluster as it was set', () => {
  it('applies its history and request counting, and tries again only after ten minutes', async () => {
    monitoring.applyHistory.mockResolvedValue(true);
    monitoring.applyRequestMetrics.mockResolvedValue('applied');
    const watch = watcher();
    await watch.tick();
    expect(logged).toEqual(['[alerts] provisioning-lunorica now keeps the history it was set to', '[alerts] provisioning-lunorica now counts each app\'s requests']);
    await watch.tick();
    expect(monitoring.applyHistory).toHaveBeenCalledTimes(1);
    clock = new Date(clock.getTime() + HISTORY_RETRY_MS);
    await watch.tick();
    expect(monitoring.applyHistory).toHaveBeenCalledTimes(2);
  });

  it('says what stopped the history or the request counting', async () => {
    monitoring.applyHistory.mockRejectedValue(new Error('helm is away'));
    monitoring.applyRequestMetrics.mockResolvedValue({ problem: 'k3s\'s Traefik has settings of its own here' });
    await watcher().tick();
    expect(logged).toEqual(['[alerts] provisioning-lunorica: its history could not be set (helm is away)', '[alerts] provisioning-lunorica: k3s\'s Traefik has settings of its own here']);
  });

  it('says a request counting that threw as a problem', async () => {
    monitoring.applyRequestMetrics.mockRejectedValue(new Error('no helm'));
    await watcher().tick();
    expect(logged).toEqual(['[alerts] provisioning-lunorica: no helm']);
  });
});

describe('the watch\'s timer', () => {
  it('passes at once, then every thirty seconds, until stopped', async () => {
    vi.useFakeTimers();
    const watch = watcher({ people: async () => [asPerson('me')] });
    watch.start();
    watch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitoring.allClusters).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    expect(monitoring.allClusters).toHaveBeenCalledTimes(2);
    watch.stop();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS * 3);
    expect(monitoring.allClusters).toHaveBeenCalledTimes(2);
  });
});
