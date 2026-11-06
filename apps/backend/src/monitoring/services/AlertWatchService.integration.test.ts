import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { principalOf } from '../../platform/lib/permissions.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import type { PromAlert } from '../lib/monitoring-alerts.js';
import { AlertWatchService, type AlertWatchDeps } from './AlertWatchService.js';
import type { MetricsClient } from './MonitoringService.js';

const ME = principalOf({ id: 'me' }, { role: 'instance', instanceOwnerId: 'me' });
const system = { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true } as ClusterMetadata;
const books = { id: 'books', name: 'Books', namespace: 'books', clusterId: system.id, strategy: 'native', appType: 'audiobookshelf', ownerId: 'me', status: 'running', createdAt: 'then' } as DeploymentMetadata;
const down: PromAlert = { labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing', activeAt: '2026-10-17T11:58:00Z' };

const fresh = await emptiedEachTime();
let db: MongoDB;
let alerts: PromAlert[];

const watcher = (tell: AlertWatchDeps['tell'], logged: string[]) => {
  const metrics = mock<MetricsClient>();
  metrics.alerts.mockImplementation(async () => alerts);
  const monitoring = mock<AlertWatchDeps['monitoring']>();
  monitoring.allClusters.mockResolvedValue([system]);
  monitoring.reach.mockResolvedValue({ cluster: system, state: 'ok', metrics });
  monitoring.syncPoolProbes.mockResolvedValue(undefined);
  monitoring.applyHistory.mockResolvedValue(false);
  monitoring.applyRequestMetrics.mockResolvedValue('already');
  monitoring.applyReceiver.mockResolvedValue(false);
  monitoring.applyRootRules.mockResolvedValue(undefined);
  let ids = 0;
  return new AlertWatchService({ monitoring, store: db, people: async () => [ME], tell, log: (line) => logged.push(line), now: () => new Date('2026-10-17T12:00:00Z'), newId: () => `ep-${ids++}` });
};

beforeEach(async () => {
  db = await fresh();
  alerts = [];
  await db.infrastructure.saveDeploymentInfo(books);
});

describe('watching alerts, kept in the database', () => {
  it('keeps one episode while an alert fires and closes it when it resolves, telling the person each time', async () => {
    const told: string[] = [];
    const watch = watcher(async (episode, change) => { told.push(`${episode.ownerId} ${change}`); }, []);
    alerts = [down];
    await watch.tick();
    await watch.tick();
    alerts = [];
    await watch.tick();
    expect(told).toEqual(['me fired', 'me resolved']);
    const [episode] = await db.monitoring.getAlertEpisodes('me');
    expect(episode).toMatchObject({ clusterId: system.id, name: 'AppProbeDown', resolvedAt: '2026-10-17T12:00:00.000Z' });
  });

  it('keeps the episode and says so when telling the person fails, and does not tell it twice', async () => {
    const logged: string[] = [];
    let tries = 0;
    const watch = watcher(async () => { tries += 1; throw new Error('mail is down'); }, logged);
    alerts = [down];
    await watch.tick();
    await watch.tick();
    expect(tries).toBe(1);
    expect(logged).toEqual(['[alerts] could not tell me: mail is down']);
    expect(await db.monitoring.getAlertEpisodes('me')).toHaveLength(1);
  });
});
