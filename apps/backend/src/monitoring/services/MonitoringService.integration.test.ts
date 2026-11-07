import { containing } from '../../platform/lib/test-matchers.js';
import { at } from '../../platform/lib/json-shapes.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { asPerson, principalOf } from '../../platform/lib/permissions.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import { appQuery, appWindowQuery, clusterQuery, koalaQuery, koalaServicesQuery, type AppSubject } from '../lib/monitoring-questions.js';
import { RULE_LABEL, alertSpec, koalaAlertExpression, type AlertSpec, type PromAlert } from '../lib/monitoring-alerts.js';
import { inCluster, OWN_SERIES } from '../lib/cluster-scope.js';
import { MonitoringService, prometheusAt, type MonitoringDeps } from './MonitoringService.js';
import { prometheusStandIn, type PrometheusStandIn } from '../testing/prometheus-stand-in.js';

import { AlertWatchService } from './AlertWatchService.js';
import type { Socket } from 'socket.io';
import { localAgentStatus, registerDevice, unregisterDevice } from '../../machines/lib/local-agent-registry.js';
import { portToHandOn } from '@koala/engine-core/testing/ports';

const fresh = await emptiedEachTime();
const prom: PrometheusStandIn = await prometheusStandIn(OWN_SERIES);
const nowhere = `http://127.0.0.1:${await portToHandOn()}`;
afterAll(() => prom.close());

const NOW = new Date('2026-10-17T12:00:00Z');
const ME = principalOf({ id: 'me' }, { role: 'instance', instanceOwnerId: 'me' });
const SOMEONE = asPerson('someone');

const system: ClusterMetadata = { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true } as ClusterMetadata;
const remote: ClusterMetadata = { id: 'c-remote', name: 'shop-box', provider: 'hetzner', status: 'healthy', ownerId: 'me' } as ClusterMetadata;

const dep = (fields: Partial<DeploymentMetadata> & { id: string; name: string }): DeploymentMetadata =>
  ({ clusterId: system.id, strategy: 'native', appType: 'audiobookshelf', ownerId: 'me', status: 'running', createdAt: 'then', ...fields }) as DeploymentMetadata;

const healthyApp = (prom: PrometheusStandIn, subject: AppSubject) => {
  prom.set(`kube_service_info{namespace=${JSON.stringify(subject.namespace)}}`, 1, { service: subject.services?.[0] ?? 'web' });
  prom.set(appQuery('probed', subject), 1).set(appQuery('up', subject), 1).set(appQuery('responseSeconds', subject), 0.2)
    .set(appQuery('podsRunning', subject), 1).set(appQuery('memoryBytes', subject), 100).set(appQuery('memoryLimitBytes', subject), 1000)
    .set(appWindowQuery('uptime', subject, 86_400), 1).set(appWindowQuery('restarts', subject, 86_400), 0);
};

let db: MongoDB;
let kubectl: string[][];
let applied: string[];
let helm: string[][];
let prometheusResource: Record<string, unknown>;
let releases: Array<Record<string, string>>;
let traefikValues: Record<string, unknown>;
let helmChartConfig: string;
let telemetryInstalled: boolean;
let monitoring: MonitoringService;
let deps: () => MonitoringDeps;

beforeEach(async () => {
  db = await fresh();
  prom.answers.clear();
  prom.series.clear();
  prom.firing = [];
  prom.asked.length = 0;
  prom.queriesFail = undefined;
  prom.set('vector(1)', 1);
  kubectl = [];
  applied = [];
  helm = [];
  prometheusResource = { spec: { retention: '10d' } };
  releases = [{ name: 'kube-prometheus-stack', namespace: 'monitoring', chart: 'kube-prometheus-stack-79.1.0' }];
  traefikValues = {};
  helmChartConfig = '';
  telemetryInstalled = true;
  deps = (): MonitoringDeps => ({
    store: db,
    systemCluster: async () => system,
    prometheus: async (cluster) => {
      if (cluster.id === system.id) return prom.client;
      return prometheusAt(nowhere);
    },
    kubectl: async (cluster, args) => {
      kubectl.push([cluster.id, ...args]);
      if (args[0] === 'get' && args[1] === 'prometheus') return JSON.stringify(prometheusResource);
      if (args[0] === 'get' && args[1] === 'service') return cluster.id === remote.id || !telemetryInstalled && args[2] !== 'kube-prometheus-stack-prometheus' ? '' : `service/${args[2]}`;
      if (args[0] === 'get' && args[1] === 'helmchartconfig') return helmChartConfig;
      return '';
    },
    apply: async (_cluster, manifest) => { applied.push(manifest); },
    helm: async (_cluster, args) => {
      helm.push(args);
      if (args[0] === 'list') return JSON.stringify(releases);
      if (args[0] === 'get') return JSON.stringify(traefikValues);
      return '';
    },
    now: () => NOW,
    newId: () => 'rule-1',
  });
  monitoring = new MonitoringService(deps());
});

describe('the overview', () => {
  it('says an app waits for its machine while the machine is offline, and only then', async () => {
    const desk = { id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', machineId: 'desk', ownerId: 'me' } as ClusterMetadata;
    await db.infrastructure.saveCluster(desk);
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'notes', name: 'Notes', namespace: 'notes', clusterId: desk.id, status: 'deploying' }));
    monitoring = new MonitoringService({ ...deps(), machineStatus: localAgentStatus });
    const offline = await monitoring.overview(ME);
    expect(offline.attention).toContainEqual({ subject: { kind: 'app', id: 'notes', name: 'Notes' }, state: 'warning', reasons: ['it waits for desk, which is offline: it deploys when the machine connects again'] });
    const socket = {} as Socket;
    registerDevice('desk', 'me', '/home/me/koala', socket);
    const connected = await monitoring.overview(ME).finally(() => unregisterDevice('desk', socket));
    expect(connected.apps.find((row) => row.id === 'notes')).toMatchObject({ state: 'installing', reasons: ['it is being deployed'] });
  });

  it('shows a machine\'s cluster at rest as stopped, reads it for no alerts, and leaves it out of what needs attention', async () => {
    const resting = { id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', machineId: 'desk', ownerId: 'me' } as ClusterMetadata;
    await db.infrastructure.saveCluster(resting);
    const overview = await monitoring.overview(ME);
    expect(overview.clusters.find((row) => row.id === 'machine-desk')).toMatchObject({ state: 'stopped', reasons: ['its machine stops it while nothing runs on it'] });
    expect(overview.attention.some((entry) => entry.subject.id === 'machine-desk')).toBe(false);
    expect((await monitoring.allClusters()).map((cluster) => cluster.id)).not.toContain('machine-desk');
  });

  it('puts an app the health pass found unhealthy under what needs attention, with why, whatever its numbers say', async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'gone', name: 'Gone', namespace: 'gone', status: 'unhealthy', healthReason: 'its namespace gone is not on its cluster, so nothing of it runs there; destroy the app or deploy it again' }));
    healthyApp(prom, { namespace: 'gone', services: ['web'] });

    const overview = await monitoring.overview(ME);

    expect(overview.attention).toEqual([{ subject: { kind: 'app', id: 'gone', name: 'Gone' }, state: 'down', reasons: ['its namespace gone is not on its cluster, so nothing of it runs there; destroy the app or deploy it again'] }]);
  });

  it('puts an app whose removal Kubernetes holds under what needs attention, with what it waits on', async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'leaving', name: 'Leaving', namespace: 'leaving', status: 'destroying', healthReason: 'it is being removed, and Kubernetes is waiting on: example.com/hold' }));

    const overview = await monitoring.overview(ME);

    expect(overview.attention).toEqual([{ subject: { kind: 'app', id: 'leaving', name: 'Leaving' }, state: 'warning', reasons: ['it is being removed, and Kubernetes is waiting on: example.com/hold'] }]);
  });

  it('lists the person\'s apps worst first, with what needs attention', async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'shop', name: 'Shop', namespace: 'shop' }));
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'theirs', name: 'Theirs', namespace: 'theirs', ownerId: 'someone' }));
    healthyApp(prom, { namespace: 'books', services: ['audiobookshelf'] });
    healthyApp(prom, { namespace: 'shop', services: ['web'] });
    prom.set(appQuery('up', { namespace: 'shop' }), 0);

    const overview = await monitoring.overview(ME);

    expect(overview.apps.map((app) => [app.name, app.state])).toEqual([['Shop', 'down'], ['Books', 'ok']]);
    expect(overview.attention).toEqual([{ subject: { kind: 'app', id: 'shop', name: 'Shop' }, state: 'down', reasons: ['it does not answer'] }]);
    expect(overview.apps[1]?.memoryShare).toBe(0.1);
  });

  it('shows a cluster without monitoring as getting it, and one that does not answer as unreachable', async () => {
    await db.infrastructure.saveCluster(remote);
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'erp', name: 'ERP', namespace: 'erp', clusterId: remote.id }));
    const overview = await monitoring.overview(ME);
    expect(overview.clusters.find((row) => row.id === remote.id)).toMatchObject({ state: 'installing', reasons: ['its monitoring is installed before its next app is deployed'] });
    expect(overview.apps[0]).toMatchObject({ name: 'ERP', state: 'installing' });
  });

  it('hides the shared system cluster from someone with no apps on it who does not own it', async () => {
    expect((await monitoring.overview(SOMEONE)).clusters).toEqual([]);
    expect((await monitoring.overview(ME)).clusters.map((row) => row.id)).toEqual([system.id]);
  });

  it('puts a firing alert among the app\'s reasons', async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    healthyApp(prom, { namespace: 'books', services: ['audiobookshelf'] });
    prom.firing = [{ labels: { alertname: 'KubePodCrashLooping', namespace: 'books' }, state: 'firing' }];
    const overview = await monitoring.overview(ME);
    expect(overview.apps[0]).toMatchObject({ state: 'warning', reasons: ['Books has a container that keeps restarting'] });
    expect(overview.firing).toHaveLength(1);
  });

  it('counts a cluster\'s machines and use', async () => {
    prom.set(clusterQuery('nodes'), 1).set(clusterQuery('diskShare'), 0.95);
    const row = (await monitoring.overview(ME)).clusters[0]!;
    expect(row).toMatchObject({ state: 'warning', reasons: ['the disk is 95% full'], numbers: { nodes: 1, nodesNotReady: 0, diskShare: 0.95 } });
  });
});

describe('an app\'s health', () => {
  it('charts it over the range, marks its releases and lists its alerts and rules', async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    healthyApp(prom, { namespace: 'books', services: ['audiobookshelf'] });
    prom.series.set(prom.scoped(appQuery('up', { namespace: 'books', services: ['audiobookshelf'] })!), [[1, 1], [2, 1]]);
    await db.releases.savePipelineRun({ id: 'run-1', projectId: 'p', deploymentId: 'books', commitSha: 'abcdef1234567', status: 'success', startedAt: '2026-10-17T10:00:00Z', promotedAt: '2026-10-17T11:00:00Z' } as never);
    await db.releases.savePipelineRun({ id: 'run-0', projectId: 'p', deploymentId: 'books', commitSha: 'old', status: 'success', startedAt: '2026-10-10T10:00:00Z', promotedAt: '2026-10-10T11:00:00Z' } as never);

    const view = await monitoring.appHealth(ME, 'books', '24h');

    expect(view.series).toEqual([{ chart: 'up', points: [[1, 1], [2, 1]] }]);
    expect(view.markers).toEqual([{ at: '2026-10-17T11:00:00Z', label: 'deployed abcdef12' }]);
    expect(view.lines[0]).toBe('Books is healthy.');
    expect(view.history).toMatchObject({ days: 10, kept: 10, applied: false, can: ['change'] });
  });

  it('is refused for someone else\'s app', async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    await expect(monitoring.appHealth(SOMEONE, 'books', '24h')).rejects.toMatchObject({ status: 404 });
  });
});

describe('history', () => {
  it('is set by whoever owns the cluster and applied with Helm at the chart\'s version', async () => {
    const history = await monitoring.setHistory(ME, system.id, 30);
    expect(helm[1]).toContain('prometheus.prometheusSpec.retention=30d');
    expect(helm[1]).toContain('79.1.0');
    expect(history.days).toBe(30);
    expect((await db.monitoring.getMonitoringSettings())[0]).toMatchObject({ clusterId: system.id, historyDays: 30, appliedAt: NOW.toISOString() });
  });

  it('refuses days out of range and people who do not own the cluster', async () => {
    await expect(monitoring.setHistory(ME, system.id, 0)).rejects.toMatchObject({ status: 400 });
    await expect(monitoring.setHistory(SOMEONE, system.id, 20)).rejects.toMatchObject({ status: 403 });
  });

  it('does nothing when Prometheus already keeps it on a volume', async () => {
    prometheusResource = { spec: { retention: '10d', retentionSize: '5GB', storage: { volumeClaimTemplate: {} } } };
    expect(await monitoring.applyHistory(system)).toBe(false);
    expect(helm).toEqual([]);
  });

  it('records why it could not be applied', async () => {
    monitoring = new MonitoringService({ ...deps(), helm: async () => { throw new Error('no route to the chart repository'); } });
    expect(await monitoring.applyHistory(system)).toBe(false);
    expect((await db.monitoring.getMonitoringSettings())[0]?.problem).toBe('no route to the chart repository');
  });
});

describe('alert rules', () => {
  beforeEach(async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    healthyApp(prom, { namespace: 'books', services: ['audiobookshelf'] });
  });

  it('becomes a PrometheusRule on the app\'s cluster and a record', async () => {
    const rule = await monitoring.addRule(ME, 'books', alertSpec('down') as AlertSpec, 'conv-1');
    expect(rule).toMatchObject({ id: 'rule-1', summary: 'Books has not answered for 5 minutes', conversationId: 'conv-1' });
    expect(at(JSON.parse(applied[0]!), 'spec', 'groups', 0, 'rules', 0, 'expr')).toBe('max(probe_success{namespace="books"}) < 1');
    expect(await db.monitoring.getAlertRules('me')).toHaveLength(1);
  });

  it('is removed from the cluster and the records', async () => {
    await monitoring.addRule(ME, 'books', alertSpec('down') as AlertSpec);
    await monitoring.removeRule(ME, 'rule-1');
    expect(kubectl.at(-1)).toEqual([system.id, 'delete', 'prometheusrule', 'koala-alert-rule-1', '-n', 'books', '--ignore-not-found']);
    expect(await db.monitoring.getAlertRules('me')).toEqual([]);
    await expect(monitoring.removeRule(SOMEONE, 'rule-1')).rejects.toMatchObject({ status: 404 });
  });

  it('says why one cannot be proposed', async () => {
    expect(await monitoring.proposeAlertProblem(ME, 'Nope', alertSpec('down') as AlertSpec)).toEqual({ error: 'no app called Nope; yours are: Books' });
    expect(await monitoring.proposeAlertProblem(ME, 'books', alertSpec('errors') as AlertSpec)).toMatchObject({ summary: containing('of its requests') });
  });
});

describe('watching alerts', () => {
  const told: string[] = [];
  const watcher = () => new AlertWatchService({
    monitoring,
    store: db,
    people: async () => [ME],
    tell: async (episode, change) => { told.push(`${episode.ownerId} ${change} ${episode.summary}`); },
    now: () => NOW,
    newId: () => `ep-${told.length}`,
  });

  beforeEach(async () => {
    told.length = 0;
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'theirs', name: 'Theirs', namespace: 'theirs', ownerId: 'someone' }));
  });

  it('tells each person once when their alert fires, and again when it resolves', async () => {
    const watch = watcher();
    prom.firing = [
      { labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing', activeAt: '2026-10-17T11:58:00Z' },
      { labels: { alertname: 'AppProbeDown', namespace: 'theirs' }, state: 'firing' },
      { labels: { alertname: 'NodeMemoryHighUtilization', instance: 'n1' }, state: 'firing' },
      { labels: { alertname: 'Watchdog' }, state: 'firing' },
    ];
    await watch.tick();
    await watch.tick();
    expect(told.sort()).toEqual(['me fired Books is not answering', 'me fired Memory is nearly full', 'someone fired Theirs is not answering']);
    expect((await db.monitoring.getAlertEpisodes('me')).find((episode) => episode.summary === 'Books is not answering')?.startedAt).toBe('2026-10-17T11:58:00Z');

    prom.firing = [];
    await watch.tick();
    expect(told.filter((line) => line.includes('resolved')).sort()).toEqual(['me resolved Books is not answering', 'me resolved Memory is nearly full', 'someone resolved Theirs is not answering']);
  });

  it('watches on its own timer until it is stopped', async () => {
    const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const until = async (done: () => boolean) => { for (let tries = 0; tries < 200 && !done(); tries += 1) await pause(10); };
    const watch = watcher();
    prom.firing = [{ labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing', activeAt: '2026-10-17T11:58:00Z' }];
    watch.start(20);
    watch.start(20);
    await until(() => told.some((line) => line.includes('fired')));
    prom.firing = [];
    await until(() => told.some((line) => line.includes('resolved')));
    watch.stop();
    expect(told.filter((line) => line.includes('Books is not answering'))).toEqual(['me fired Books is not answering', 'me resolved Books is not answering']);

    await pause(60);
    const asked = prom.asked.length;
    await pause(100);
    expect(prom.asked.length).toBe(asked);
  });

  it('tells only the rule\'s owner about it', async () => {
    await db.monitoring.saveAlertRule({ id: 'r1', ownerId: 'me', deploymentId: 'books', clusterId: system.id, namespace: 'books', appName: 'Books', spec: alertSpec('down') as AlertSpec, summary: 'Books: down', createdAt: 'then' });
    prom.firing = [{ labels: { alertname: 'Koala_down', namespace: 'books', [RULE_LABEL]: 'r1' }, annotations: { summary: 'Books: down' }, state: 'firing' }];
    await watcher().tick();
    expect(told).toEqual(['me fired Books: down']);
  });

  it('keeps an episode open while its cluster cannot be read', async () => {
    const watch = watcher();
    prom.firing = [{ labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing' }];
    await watch.tick();
    prom.answers.delete('vector(1)');
    prom.queriesFail = 'down';
    prom.firing = [];
    await watch.tick();
    expect(told.filter((line) => line.includes('resolved'))).toEqual([]);
  });
});

describe('counting each app\'s requests', () => {
  it('switches our Traefik\'s service labels on once', async () => {
    releases.push({ name: 'traefik', namespace: 'traefik', chart: 'traefik-41.4.0' });
    expect(await monitoring.applyRequestMetrics(system)).toBe('applied');
    expect(helm.at(-1)).toContain('metrics.prometheus.addServicesLabels=true');
    traefikValues = { metrics: { prometheus: { addServicesLabels: true } } };
    expect(await monitoring.applyRequestMetrics(system)).toBe('already');
  });

  it('configures k3s\'s Traefik, and leaves one the person configured alone', async () => {
    releases.push({ name: 'traefik', namespace: 'kube-system', chart: 'traefik-34.2.1' });
    expect(await monitoring.applyRequestMetrics(system)).toBe('applied');
    expect(JSON.parse(applied[0]!)).toMatchObject({ kind: 'HelmChartConfig', metadata: { name: 'traefik', namespace: 'kube-system' } });
    helmChartConfig = JSON.stringify({ metadata: { labels: {} }, spec: { valuesContent: 'ports: {}' } });
    expect(await monitoring.applyRequestMetrics(system)).toEqual({ problem: 'k3s\'s Traefik has settings of its own here, so request counting was not switched on' });
    expect(applied).toHaveLength(1);
  });
});

describe('a cluster on Koala\'s servers', () => {
  class FakePool {
    asked: unknown[] = [];
    rules: unknown[] = [];
    removed: string[] = [];
    probes: unknown[][] = [];
    firing: PromAlert[] = [];
    async ask(ask: unknown) {
      this.asked.push(ask);
      const kind = (ask as { kind: string; question?: string }).kind;
      const question = (ask as { question?: string }).question;
      if (kind === 'app' && (question === 'up' || question === 'probed' || question === 'podsRunning')) return [{ metric: {}, value: 1 }];
      if (kind === 'cluster' && question === 'nodes') return [{ metric: {}, value: 1 }];
      return [];
    }
    async askRange() { return [[1, 1]] as Array<[number, number]>; }
    async alerts() { return this.firing; }
    async history() { return { days: 10, kept: 10 }; }
    async setRule(rule: unknown) { this.rules.push(rule); }
    async removeRule(id: string) { this.removed.push(id); }
    async setProbes(probes: unknown[]) { this.probes.push(probes); }
  }

  let pool: FakePool;
  let probesJson: string;

  beforeEach(() => {
    pool = new FakePool();
    probesJson = JSON.stringify({ items: [{ metadata: { namespace: 'shop' }, spec: { module: 'http_2xx', targets: { staticConfig: { static: ['web.shop.svc.cluster.local:80/health'] } } } }] });
    const base = deps();
    monitoring = new MonitoringService({
      ...base,
      pool: (cluster) => (cluster.isSystem ? pool : undefined),
      prometheus: async () => { throw new Error('a pool instance has no Prometheus of its own'); },
      kubectl: async (cluster, args) => {
        kubectl.push([cluster.id, ...args]);
        return args[1] === 'probes.monitoring.coreos.com' ? probesJson : '';
      },
    });
  });

  it('asks root its named questions, never a query, and reads the app as healthy', async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'shop', name: 'Shop', namespace: 'shop' }));
    const view = await monitoring.appHealth(ME, 'shop', '1h');
    expect(view.app.state).toBe('ok');
    expect(pool.asked).toContainEqual({ kind: 'app', question: 'up', subject: { namespace: 'shop', services: [] } });
    expect(pool.asked.every((ask) => typeof ask === 'object' && !('query' in (ask as object)))).toBe(true);
    expect(view.series.map((entry) => entry.chart)).toContain('up');
  });

  it('keeps the history Koala\'s servers keep, which the person cannot change', async () => {
    const view = await monitoring.clusterHealth(ME, system.id, '1h');
    expect(view.cluster.history).toEqual({ days: 10, kept: 10, applied: true, can: [], byKoala: true });
    await expect(monitoring.setHistory(ME, system.id, 20)).rejects.toThrow('Koala\'s servers keep this history');
    expect(await monitoring.applyHistory(system)).toBe(false);
  });

  it('hands an alert to root to set, and refuses one on requests, which are not counted there', async () => {
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'shop', name: 'Shop', namespace: 'shop' }));
    const rule = await monitoring.addRule(ME, 'shop', alertSpec('down') as AlertSpec);
    expect(pool.rules).toEqual([{ id: rule.id, namespace: 'shop', spec: rule.spec, summary: rule.summary }]);
    expect(applied).toEqual([]);
    await expect(monitoring.addRule(ME, 'shop', alertSpec('errors') as AlertSpec)).rejects.toThrow('requests are not counted on Koala\'s servers');
    await monitoring.removeRule(ME, rule.id);
    expect(pool.removed).toEqual([rule.id]);
  });

  it('hands its apps\' probes to root, and only again when they change', async () => {
    await monitoring.syncPoolProbes(system);
    await monitoring.syncPoolProbes(system);
    expect(pool.probes).toEqual([[{ namespace: 'shop', service: 'web', port: 80, path: '/health', module: 'http_2xx' }]]);
    probesJson = JSON.stringify({ items: [] });
    await monitoring.syncPoolProbes(system);
    expect(pool.probes).toHaveLength(2);
    await monitoring.syncPoolProbes(remote);
    expect(pool.probes).toHaveLength(2);
  });

  it('says how much of its place it uses', async () => {
    pool.ask = async (ask: unknown) => {
      const question = (ask as { question?: string }).question;
      return question === 'nodes' ? [{ metric: {}, value: 1 }] : question === 'memoryShare' ? [{ metric: {}, value: 0.5 }] : [];
    };
    const view = await monitoring.clusterHealth(ME, system.id, '1h');
    expect(view.lines).toContain('In use of its place on Koala\'s servers: memory 50%.');
    pool.ask = async (ask: unknown) => {
      const question = (ask as { question?: string }).question;
      return question === 'nodes' ? [{ metric: {}, value: 1 }] : question === 'diskShare' ? [{ metric: {}, value: 0.95 }] : [];
    };
    const full = await monitoring.clusterHealth(ME, system.id, '1h');
    expect(full.cluster.reasons).toContain('95% of its place\'s storage is claimed');
    expect(full.lines).toContain('In use of its place on Koala\'s servers: storage claimed 95%.');
  });
});

describe('Koala itself', () => {
  const reporting = () => {
    prom.answers.set(prom.scoped(koalaServicesQuery()), [{ metric: { service_name: 'koala-worker-engine' }, value: 1 }, { metric: { service_name: 'koala-backend' }, value: 1 }]);
    prom.set(koalaQuery('requestsPerSecond'), 1.5).set(koalaQuery('requestErrorShare'), 0).set(koalaQuery('requestSeconds'), 0.1)
      .set(koalaQuery('modelCallsPerMinute'), 2).set(koalaQuery('modelErrorShare'), 0).set(koalaQuery('modelSeconds'), 8).set(koalaQuery('modelQueued'), 0)
      .set(koalaQuery('workflowsStartedHour'), 4).set(koalaQuery('activityFailuresHour'), 0).set(koalaQuery('workFailuresDay'), 0).set(koalaQuery('reporting'), 2);
  };

  it('is read from the system cluster\'s Prometheus through the same named questions as an app, for anyone', async () => {
    reporting();
    const view = await monitoring.koala(SOMEONE);
    expect(view).toMatchObject({ state: 'ok', reasons: [], services: ['koala-backend', 'koala-worker-engine'], telemetry: { collector: true, tempo: true } });
    expect(view.numbers).toMatchObject({ requestsPerSecond: 1.5, modelCallsPerMinute: 2, workflowsStartedHour: 4 });
    expect(view.lines[0]).toBe('Koala is healthy.');
    expect(view.lines[1]).toBe('2 processes report: koala-backend, koala-worker-engine.');
    expect(prom.asked).toContain(prom.scoped(koalaQuery('modelQueued')));
    expect((await monitoring.describeOverview(ME))).toContain('Koala itself: Koala is healthy. 2 processes report');
  });

  it('is down when nothing of Koala reports, and getting its monitoring while the collector or Tempo is missing', async () => {
    expect(await monitoring.koala(ME)).toMatchObject({ state: 'down', reasons: ['no part of Koala is reporting'], services: [] });
    telemetryInstalled = false;
    expect(await monitoring.koala(ME)).toMatchObject({ state: 'installing', telemetry: { collector: false, tempo: false }, numbers: {} });
  });

  it('takes its own alerts, set on "koala" by whoever runs it, as a PrometheusRule in the monitoring namespace', async () => {
    reporting();
    const spec = alertSpec('model_errors') as AlertSpec;
    expect(await monitoring.proposeAlertProblem(ME, 'koala', spec)).toEqual({ subject: { id: 'koala', name: 'Koala' }, summary: 'Tell me when over 20% of Koala\'s model calls fail for 10 minutes' });
    expect(await monitoring.proposeAlertProblem(SOMEONE, 'koala', spec)).toEqual({ error: 'only whoever runs this Koala can set alerts on Koala itself' });
    expect(await monitoring.proposeAlertProblem(ME, 'koala', alertSpec('down') as AlertSpec)).toEqual({ error: 'down is an alert about an app; on Koala itself the kinds are koala_down, model_errors and workflow_failures' });
    expect(await monitoring.proposeAlertProblem(ME, 'books', spec)).toEqual({ error: 'model_errors is an alert about Koala itself; name "koala", not an app' });

    const rule = await monitoring.addRule(ME, 'koala', spec, 'conv-1');
    expect(rule).toMatchObject({ deploymentId: 'koala', namespace: 'monitoring', appName: 'Koala', clusterId: system.id, conversationId: 'conv-1' });
    const manifest = JSON.parse(applied[0]!) as { metadata: { namespace: string }; spec: { groups: { rules: { expr: string }[] }[] } };
    expect(manifest.metadata.namespace).toBe('monitoring');
    expect(manifest.spec.groups[0]!.rules[0]!.expr).toBe(koalaAlertExpression(spec));
    await expect(monitoring.addRule(ME, 'books', spec)).rejects.toMatchObject({ status: 400 });

    prom.firing = [{ labels: { alertname: 'Koala_model_errors', [RULE_LABEL]: rule.id, namespace: 'monitoring' }, annotations: { summary: rule.summary }, state: 'firing' }];
    expect(await monitoring.koala(ME)).toMatchObject({ state: 'warning', reasons: [rule.summary] });
    expect((await monitoring.alerts(ME)).firing).toEqual([expect.objectContaining({ ruleId: rule.id, about: { kind: 'koala' } })]);

    await monitoring.removeRule(ME, rule.id);
    expect(kubectl.at(-1)).toEqual([system.id, 'delete', 'prometheusrule', `koala-alert-${rule.id}`, '-n', 'monitoring', '--ignore-not-found']);
  });
});

describe('a machine\'s cluster, which sends to the system cluster\'s Prometheus', () => {
  const desk = { id: 'machine-desk', name: 'desk', provider: 'machine', status: 'healthy', machineId: 'desk', ownerId: 'me' } as ClusterMetadata;
  const onDesk = (query: string | undefined, value: number) => { if (query) prom.answers.set(inCluster(query, desk.id), [{ metric: {}, value }]); };

  beforeEach(async () => {
    await db.infrastructure.saveCluster(desk);
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books', clusterId: desk.id }));
  });

  it('is read there, every question kept to its own series, and the system cluster\'s to the series no machine sent', async () => {
    const subject = { namespace: 'books', services: [] };
    onDesk(appQuery('probed', subject), 1);
    onDesk(appQuery('up', subject), 1);
    onDesk(appQuery('podsRunning', subject), 1);
    onDesk(clusterQuery('nodes'), 1);
    prom.set(clusterQuery('nodes'), 3);
    const overview = await monitoring.overview(ME);
    expect(overview.apps.find((row) => row.id === 'books')).toMatchObject({ state: 'ok', numbers: { up: 1, podsRunning: 1 } });
    expect(overview.clusters.find((row) => row.id === desk.id)?.numbers.nodes).toBe(1);
    expect(overview.clusters.find((row) => row.id === system.id)?.numbers.nodes).toBe(3);
    expect(prom.asked.every((query) => query.includes('koala_cluster=') || !/[a-z_]+\{|[a-z_]+\)/.test(query))).toBe(true);
    expect(kubectl.some((call) => call[0] === desk.id)).toBe(false);
  });

  it('hands each cluster only the alerts its own series raised', async () => {
    prom.firing = [
      { labels: { alertname: 'AppProbeDown', namespace: 'books', koala_cluster: desk.id }, state: 'firing' },
      { labels: { alertname: 'AppProbeDown', namespace: 'shop' }, state: 'firing' },
    ];
    const deskAlerts = await (await monitoring.reach(desk)).metrics!.alerts();
    const systemAlerts = await (await monitoring.reach(system)).metrics!.alerts();
    expect(deskAlerts.map((alert) => alert.labels.namespace)).toEqual(['books']);
    expect(systemAlerts.map((alert) => alert.labels.namespace)).toEqual(['shop']);
  });

  it('keeps an app\'s alert as a rule on the system cluster, in monitoring, held to the machine\'s series and named for it', async () => {
    await monitoring.addRule(ME, 'books', alertSpec('down') as AlertSpec);
    const manifest = JSON.parse(applied[0]!) as Record<string, unknown>;
    expect(at(manifest, 'metadata', 'namespace')).toBe('monitoring');
    expect(at(manifest, 'spec', 'groups', 0, 'rules', 0, 'expr')).toBe('max(probe_success{koala_cluster="machine-desk",namespace="books"}) < 1');
    expect(at(manifest, 'spec', 'groups', 0, 'rules', 0, 'labels')).toMatchObject({ namespace: 'books', koala_cluster: desk.id });
    await monitoring.removeRule(ME, 'rule-1');
    expect(kubectl.at(-1)).toEqual([system.id, 'delete', 'prometheusrule', 'koala-alert-rule-1', '-n', 'monitoring', '--ignore-not-found']);
  });

  it('keeps the system cluster\'s history, which nobody changes from the machine', async () => {
    expect(await monitoring.historyOf(ME, desk)).toMatchObject({ days: 10, kept: 10, can: [] });
    await expect(monitoring.setHistory(ME, desk.id, 20)).rejects.toMatchObject({ status: 409 });
    expect(await monitoring.applyHistory(desk)).toBe(false);
  });
});

describe('the system cluster\'s Prometheus taking what machines send', () => {
  it('is switched on once, at the chart\'s version, and only on the system cluster', async () => {
    expect(await monitoring.applyReceiver(system)).toBe(true);
    expect(helm.at(-1)).toEqual(['upgrade', 'kube-prometheus-stack', 'kube-prometheus-stack', '--repo', 'https://prometheus-community.github.io/helm-charts', '--version', '79.1.0', '-n', 'monitoring', '--reuse-values', '--set', 'prometheus.prometheusSpec.enableRemoteWriteReceiver=true']);
    prometheusResource = { spec: { retention: '10d', enableRemoteWriteReceiver: true } };
    const asked = helm.length;
    expect(await monitoring.applyReceiver(system)).toBe(false);
    expect(await monitoring.applyReceiver(remote)).toBe(false);
    expect(helm.length).toBe(asked);
  });
});

describe('Koala\'s own cluster when Koala runs on a machine', () => {
  const onOwn = (query: string | undefined, value: number) => prom.set(query, value);
  const own = { id: 'machine-home', name: 'home', provider: 'machine', status: 'healthy', machineId: 'home', isSystem: true } as ClusterMetadata;

  it('keeps its own history and reads its own series, never sending itself to itself', async () => {
    monitoring = new MonitoringService({ ...deps(), systemCluster: async () => own, prometheus: async () => prom.client });
    expect(await monitoring.historyOf(ME, own)).toMatchObject({ days: 10, kept: 10 });
    onOwn(clusterQuery('nodes'), 2);
    expect((await monitoring.clusterHealth(ME, own.id, '1h')).cluster.numbers.nodes).toBe(2);
  });
});

describe('root\'s own alerts', () => {
  it('are written as one PrometheusRule into the system cluster of a root, and nowhere else', async () => {
    await monitoring.applyRootRules(system);
    expect(applied).toEqual([]);
    monitoring = new MonitoringService({ ...deps(), rootAlerts: true });
    await monitoring.applyRootRules({ ...system, isSystem: false } as ClusterMetadata);
    expect(applied).toEqual([]);
    await monitoring.applyRootRules(system);
    const written = applied.map((manifest) => JSON.parse(manifest) as { kind: string; metadata: { name: string } });
    expect(written.map((manifest) => [manifest.kind, manifest.metadata.name])).toEqual([['PrometheusRule', 'koala-root-alerts']]);
  });
});
