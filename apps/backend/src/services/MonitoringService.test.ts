import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';
import { appQuery, appWindowQuery, clusterQuery, type AppSubject } from '../lib/monitoring-questions.js';
import { RULE_LABEL, alertSpec, type AlertSpec, type PromAlert } from '../lib/monitoring-alerts.js';
import { MonitoringService, type MonitoringDeps, type PrometheusClient, type Sample } from './MonitoringService.js';
import { AlertWatchService } from './AlertWatchService.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const ME = { id: 'me' };
const SOMEONE = { id: 'someone' };

const system: ClusterMetadata = { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true } as ClusterMetadata;
const remote: ClusterMetadata = { id: 'c-remote', name: 'shop-box', provider: 'remote', status: 'healthy', ownerId: 'me' } as ClusterMetadata;

const dep = (fields: Partial<DeploymentMetadata> & { id: string; name: string }): DeploymentMetadata =>
  ({ clusterId: system.id, strategy: 'native', appType: 'audiobookshelf', ownerId: 'me', status: 'running', createdAt: 'then', ...fields }) as DeploymentMetadata;

class FakePrometheus implements PrometheusClient {
  answers = new Map<string, Sample[]>();
  series = new Map<string, Array<[number, number]>>();
  firing: PromAlert[] = [];
  asked: string[] = [];

  set(query: string | undefined, value: number, metric: Record<string, string> = {}) {
    if (query) this.answers.set(query, [{ metric, value }]);
    return this;
  }

  async query(query: string) { this.asked.push(query); return this.answers.get(query) ?? []; }
  async range(query: string) { return this.series.get(query) ?? []; }
  async alerts() { return this.firing; }
}

const healthyApp = (prom: FakePrometheus, subject: AppSubject) => {
  prom.set(`kube_service_info{namespace=${JSON.stringify(subject.namespace)}}`, 1, { service: subject.services?.[0] ?? 'web' });
  prom.set(appQuery('probed', subject), 1).set(appQuery('up', subject), 1).set(appQuery('responseSeconds', subject), 0.2)
    .set(appQuery('podsRunning', subject), 1).set(appQuery('memoryBytes', subject), 100).set(appQuery('memoryLimitBytes', subject), 1000)
    .set(appWindowQuery('uptime', subject, 86_400), 1).set(appWindowQuery('restarts', subject, 86_400), 0);
};

let db: MemoryDB;
let prom: FakePrometheus;
let remoteProm: FakePrometheus | undefined;
let kubectl: string[][];
let applied: string[];
let helm: string[][];
let prometheusResource: Record<string, unknown>;
let releases: Array<Record<string, string>>;
let traefikValues: Record<string, unknown>;
let helmChartConfig: string;
let monitoring: MonitoringService;
let deps: () => MonitoringDeps;

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  prom = new FakePrometheus().set('vector(1)', 1);
  remoteProm = undefined;
  kubectl = [];
  applied = [];
  helm = [];
  prometheusResource = { spec: { retention: '10d' } };
  releases = [{ name: 'kube-prometheus-stack', namespace: 'monitoring', chart: 'kube-prometheus-stack-79.1.0' }];
  traefikValues = {};
  helmChartConfig = '';
  deps = (): MonitoringDeps => ({
    store: db,
    systemCluster: async () => system,
    ownsSystem: (viewer) => viewer.id === 'me',
    prometheus: async (cluster) => {
      if (cluster.id === system.id) return prom;
      if (remoteProm) return remoteProm;
      throw new Error('connection refused');
    },
    kubectl: async (cluster, args) => {
      kubectl.push([cluster.id, ...args]);
      if (args[0] === 'get' && args[1] === 'prometheus') return JSON.stringify(prometheusResource);
      if (args[0] === 'get' && args[1] === 'service') return cluster.id === remote.id ? '' : 'service/kube-prometheus-stack-prometheus';
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
  it('lists the person\'s apps worst first, with what needs attention', async () => {
    await db.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    await db.saveDeploymentInfo(dep({ id: 'shop', name: 'Shop', namespace: 'shop' }));
    await db.saveDeploymentInfo(dep({ id: 'theirs', name: 'Theirs', namespace: 'theirs', ownerId: 'someone' }));
    healthyApp(prom, { namespace: 'books', services: ['audiobookshelf'] });
    healthyApp(prom, { namespace: 'shop', services: ['web'] });
    prom.set(appQuery('up', { namespace: 'shop' }), 0);

    const overview = await monitoring.overview(ME);

    expect(overview.apps.map((app) => [app.name, app.state])).toEqual([['Shop', 'down'], ['Books', 'ok']]);
    expect(overview.attention).toEqual([{ subject: { kind: 'app', id: 'shop', name: 'Shop' }, state: 'down', reasons: ['it does not answer'] }]);
    expect(overview.apps[1]?.memoryShare).toBe(0.1);
  });

  it('shows a cluster without monitoring as getting it, and one that does not answer as unreachable', async () => {
    await db.saveCluster(remote);
    await db.saveDeploymentInfo(dep({ id: 'erp', name: 'ERP', namespace: 'erp', clusterId: remote.id }));
    const overview = await monitoring.overview(ME);
    expect(overview.clusters.find((row) => row.id === remote.id)).toMatchObject({ state: 'installing', reasons: ['its monitoring is installed before its next app is deployed'] });
    expect(overview.apps[0]).toMatchObject({ name: 'ERP', state: 'installing' });
  });

  it('hides the shared system cluster from someone with no apps on it who does not own it', async () => {
    expect((await monitoring.overview(SOMEONE)).clusters).toEqual([]);
    expect((await monitoring.overview(ME)).clusters.map((row) => row.id)).toEqual([system.id]);
  });

  it('puts a firing alert among the app\'s reasons', async () => {
    await db.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
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
    await db.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    healthyApp(prom, { namespace: 'books', services: ['audiobookshelf'] });
    prom.series.set(appQuery('up', { namespace: 'books', services: ['audiobookshelf'] })!, [[1, 1], [2, 1]]);
    await db.savePipelineRun({ id: 'run-1', projectId: 'p', deploymentId: 'books', commitSha: 'abcdef1234567', status: 'success', startedAt: '2026-10-17T10:00:00Z', promotedAt: '2026-10-17T11:00:00Z' } as never);
    await db.savePipelineRun({ id: 'run-0', projectId: 'p', deploymentId: 'books', commitSha: 'old', status: 'success', startedAt: '2026-10-10T10:00:00Z', promotedAt: '2026-10-10T11:00:00Z' } as never);

    const view = await monitoring.appHealth(ME, 'books', '24h');

    expect(view.series).toEqual([{ chart: 'up', points: [[1, 1], [2, 1]] }]);
    expect(view.markers).toEqual([{ at: '2026-10-17T11:00:00Z', label: 'deployed abcdef12' }]);
    expect(view.lines[0]).toBe('Books is healthy.');
    expect(view.history).toMatchObject({ days: 10, kept: 10, applied: false, canChange: true });
  });

  it('is refused for someone else\'s app', async () => {
    await db.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    await expect(monitoring.appHealth(SOMEONE, 'books', '24h')).rejects.toMatchObject({ status: 404 });
  });
});

describe('history', () => {
  it('is set by whoever owns the cluster and applied with Helm at the chart\'s version', async () => {
    const history = await monitoring.setHistory(ME, system.id, 30);
    expect(helm[1]).toContain('prometheus.prometheusSpec.retention=30d');
    expect(helm[1]).toContain('79.1.0');
    expect(history.days).toBe(30);
    expect((await db.getMonitoringSettings())[0]).toMatchObject({ clusterId: system.id, historyDays: 30, appliedAt: NOW.toISOString() });
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
    expect((await db.getMonitoringSettings())[0]?.problem).toBe('no route to the chart repository');
  });
});

describe('alert rules', () => {
  beforeEach(async () => {
    await db.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    healthyApp(prom, { namespace: 'books', services: ['audiobookshelf'] });
  });

  it('becomes a PrometheusRule on the app\'s cluster and a record', async () => {
    const rule = await monitoring.addRule(ME, 'books', alertSpec('down') as AlertSpec, 'conv-1');
    expect(rule).toMatchObject({ id: 'rule-1', summary: 'Books has not answered for 5 minutes', conversationId: 'conv-1' });
    expect(JSON.parse(applied[0]!).spec.groups[0].rules[0].expr).toBe('max(probe_success{namespace="books"}) < 1');
    expect(await db.getAlertRules('me')).toHaveLength(1);
  });

  it('is removed from the cluster and the records', async () => {
    await monitoring.addRule(ME, 'books', alertSpec('down') as AlertSpec);
    await monitoring.removeRule(ME, 'rule-1');
    expect(kubectl.at(-1)).toEqual([system.id, 'delete', 'prometheusrule', 'koala-alert-rule-1', '-n', 'books', '--ignore-not-found']);
    expect(await db.getAlertRules('me')).toEqual([]);
    await expect(monitoring.removeRule(SOMEONE, 'rule-1')).rejects.toMatchObject({ status: 404 });
  });

  it('says why one cannot be proposed', async () => {
    expect(await monitoring.proposeAlertProblem(ME, 'Nope', alertSpec('down') as AlertSpec)).toEqual({ error: 'no app called Nope; yours are: Books' });
    expect(await monitoring.proposeAlertProblem(ME, 'books', alertSpec('errors') as AlertSpec)).toMatchObject({ summary: expect.stringContaining('of its requests') });
  });
});

describe('watching alerts', () => {
  const told: string[] = [];
  const watcher = () => new AlertWatchService({
    monitoring,
    store: db,
    systemOwners: async () => ['me'],
    tell: async (episode, change) => { told.push(`${episode.ownerId} ${change} ${episode.summary}`); },
    now: () => NOW,
    newId: () => `ep-${told.length}`,
  });

  beforeEach(async () => {
    told.length = 0;
    await db.saveDeploymentInfo(dep({ id: 'books', name: 'Books', namespace: 'books' }));
    await db.saveDeploymentInfo(dep({ id: 'theirs', name: 'Theirs', namespace: 'theirs', ownerId: 'someone' }));
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
    expect((await db.getAlertEpisodes('me')).find((episode) => episode.summary === 'Books is not answering')?.startedAt).toBe('2026-10-17T11:58:00Z');

    prom.firing = [];
    await watch.tick();
    expect(told.filter((line) => line.includes('resolved')).sort()).toEqual(['me resolved Books is not answering', 'me resolved Memory is nearly full', 'someone resolved Theirs is not answering']);
  });

  it('tells only the rule\'s owner about it', async () => {
    await db.saveAlertRule({ id: 'r1', ownerId: 'me', deploymentId: 'books', clusterId: system.id, namespace: 'books', appName: 'Books', spec: alertSpec('down') as AlertSpec, summary: 'Books: down', createdAt: 'then' });
    prom.firing = [{ labels: { alertname: 'Koala_down', namespace: 'books', [RULE_LABEL]: 'r1' }, annotations: { summary: 'Books: down' }, state: 'firing' }];
    await watcher().tick();
    expect(told).toEqual(['me fired Books: down']);
  });

  it('keeps an episode open while its cluster cannot be read', async () => {
    const watch = watcher();
    prom.firing = [{ labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'firing' }];
    await watch.tick();
    prom.answers.delete('vector(1)');
    prom.query = async () => { throw new Error('down'); };
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
    await db.saveDeploymentInfo(dep({ id: 'shop', name: 'Shop', namespace: 'shop' }));
    const view = await monitoring.appHealth(ME, 'shop', '1h');
    expect(view.app.state).toBe('ok');
    expect(pool.asked).toContainEqual({ kind: 'app', question: 'up', subject: { namespace: 'shop', services: [] } });
    expect(pool.asked.every((ask) => typeof ask === 'object' && !('query' in (ask as object)))).toBe(true);
    expect(view.series.map((entry) => entry.chart)).toContain('up');
  });

  it('keeps the history Koala\'s servers keep, which the person cannot change', async () => {
    const view = await monitoring.clusterHealth(ME, system.id, '1h');
    expect(view.cluster.history).toEqual({ days: 10, kept: 10, applied: true, canChange: false, byKoala: true });
    await expect(monitoring.setHistory(ME, system.id, 20)).rejects.toThrow('Koala\'s servers keep this history');
    expect(await monitoring.applyHistory(system)).toBe(false);
  });

  it('hands an alert to root to set, and refuses one on requests, which are not counted there', async () => {
    await db.saveDeploymentInfo(dep({ id: 'shop', name: 'Shop', namespace: 'shop' }));
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
