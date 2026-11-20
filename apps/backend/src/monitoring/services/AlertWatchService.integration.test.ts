import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { principalOf } from '../../platform/lib/permissions.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import type { PromAlert } from '../lib/monitoring-alerts.js';
import { AlertWatchService, type AlertWatchDeps } from './AlertWatchService.js';
import { metricsOf } from './MonitoringService.js';
import { prometheusStandIn } from '../testing/prometheus-stand-in.js';

const ME = principalOf({ id: 'me' }, { role: 'instance', instanceOwnerId: 'me' });
const koalas = { id: 'machine-koala', name: 'koala', provider: 'machine', machineId: 'koala', status: 'healthy', ownerId: 'me' } as ClusterMetadata;
const books = { id: 'books', name: 'Books', namespace: 'books', clusterId: koalas.id, strategy: 'native', appType: 'audiobookshelf', ownerId: 'me', status: 'running', createdAt: 'then' } as DeploymentMetadata;
const down: PromAlert = { labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing', activeAt: '2026-10-17T11:58:00Z' };

const fresh = await emptiedEachTime();
const prom = await prometheusStandIn();
afterAll(() => prom.close());
let db: MongoDB;

const watcher = (tell: AlertWatchDeps['tell'], logged: string[]) => {
  const metrics = metricsOf(prom.client);
  const monitoring = mock<AlertWatchDeps['monitoring']>();
  monitoring.allClusters.mockResolvedValue([koalas]);
  monitoring.reach.mockResolvedValue({ cluster: koalas, state: 'ok', metrics });
  monitoring.applyHistory.mockResolvedValue(false);
  monitoring.applyRequestMetrics.mockResolvedValue('already');
  monitoring.applyReceiver.mockResolvedValue(false);
  monitoring.applyOwnRules.mockResolvedValue(undefined);
  let ids = 0;
  return new AlertWatchService({ monitoring, store: db, people: async () => [ME], tell, log: (line) => logged.push(line), now: () => new Date('2026-10-17T12:00:00Z'), newId: () => `ep-${ids++}` });
};

beforeEach(async () => {
  db = await fresh();
  prom.firing = [];
  await db.infrastructure.saveDeploymentInfo(books);
});

describe('watching alerts, kept in the database', () => {
  it('keeps one episode while an alert fires and closes it when it resolves, telling the person each time', async () => {
    const told: string[] = [];
    const watch = watcher(async (episode, change) => { told.push(`${episode.ownerId} ${change}`); }, []);
    prom.firing = [down];
    await watch.tick();
    await watch.tick();
    prom.firing = [];
    await watch.tick();
    expect(told).toEqual(['me fired', 'me resolved']);
    const [episode] = await db.monitoring.getAlertEpisodes('me');
    expect(episode).toMatchObject({ clusterId: koalas.id, name: 'AppProbeDown', resolvedAt: '2026-10-17T12:00:00.000Z' });
  });

  it('keeps the episode and says so when telling the person fails, and does not tell it twice', async () => {
    const logged: string[] = [];
    let tries = 0;
    const watch = watcher(async () => { tries += 1; throw new Error('mail is down'); }, logged);
    prom.firing = [down];
    await watch.tick();
    await watch.tick();
    expect(tries).toBe(1);
    expect(logged).toEqual(['[alerts] could not tell me: mail is down']);
    expect(await db.monitoring.getAlertEpisodes('me')).toHaveLength(1);
  });
});
