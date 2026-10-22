import { randomUUID } from 'node:crypto';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { sanitizeNamespace } from '../../models/lib/model-registry.js';
import {
  APP_CHARTS, APP_QUESTIONS, CLUSTER_CHARTS, CLUSTER_QUESTIONS, RANGE_SECONDS, stepFor,
  type AppChart, type AppSubject, type ClusterChart, type Range,
} from '../lib/monitoring-questions.js';
import { askQuery, type MonitoringAsk, type RangeAsk } from '../lib/monitoring-asks.js';
import { probesFromCluster, probesKey, type PoolProbe, type PoolRule } from '../lib/pool-monitoring.js';
import {
  appLines, appVerdict, clusterLines, clusterVerdict, share, worstFirst,
  type AppNumbers, type ClusterNumbers, type HealthState,
} from '../lib/monitoring-summary.js';
import {
  ALERT_RULES, alertExpression, alertSummary, alertRuleManifest, ruleResourceName, visibleAlerts,
  type AlertRuleRecord, type AlertSpec, type PromAlert, type VisibleAlert,
} from '../lib/monitoring-alerts.js';
import {
  DEFAULT_HISTORY_DAYS, chartVersionOf, helmHistoryArgs, historyApplied, historyProblem, keptDays, prometheusNow,
} from '../lib/monitoring-history.js';
import type { AlertEpisode, MonitoringSetting } from '../lib/monitoring-records.js';
import { K3S_TRAEFIK_CONFIG, k3sConfigState, ourTraefikArgs, servicesLabelled, traefikOf, type HelmRelease } from '../../platform/lib/request-metrics.js';

export interface Sample {
  metric: Record<string, string>;
  value: number;
}

export interface PrometheusClient {
  query(query: string): Promise<Sample[]>;
  range(query: string, start: number, end: number, step: number): Promise<Array<[number, number]>>;
  alerts(): Promise<PromAlert[]>;
}

export interface MetricsClient {
  ask(ask: MonitoringAsk): Promise<Sample[]>;
  askRange(ask: MonitoringAsk, range: RangeAsk): Promise<Array<[number, number]>>;
  alerts(): Promise<PromAlert[]>;
}

export function metricsOf(prometheus: PrometheusClient): MetricsClient {
  return {
    async ask(ask) {
      const query = askQuery(ask);
      return query ? prometheus.query(query) : [];
    },
    async askRange(ask, range) {
      const query = askQuery(ask);
      return query ? prometheus.range(query, range.start, range.end, range.step) : [];
    },
    alerts: () => prometheus.alerts(),
  };
}

export interface PoolMonitor extends MetricsClient {
  history(): Promise<{ days: number; kept?: number | undefined }>;
  setRule(rule: PoolRule): Promise<void>;
  removeRule(id: string): Promise<void>;
  setProbes(probes: PoolProbe[]): Promise<void>;
}

export function prometheusAt(base: string, fetchImpl: typeof fetch = fetch): PrometheusClient {
  const root = base.endsWith('/') ? base : `${base}/`;
  const get = async (path: string): Promise<any> => {
    const response = await fetchImpl(`${root}api/v1/${path}`);
    const body = await response.json().catch(() => undefined) as { status?: string; data?: unknown; error?: string } | undefined;
    if (!response.ok || body?.status !== 'success') throw new Error(`Prometheus answered ${response.status}${body?.error ? `: ${body.error}` : ''}`);
    return body.data;
  };
  return {
    async query(query) {
      const data = await get(`query?query=${encodeURIComponent(query)}`);
      return (data.result as Array<{ metric: Record<string, string>; value: [number, string] }>).map((entry) => ({ metric: entry.metric, value: Number(entry.value[1]) }));
    },
    async range(query, start, end, step) {
      const data = await get(`query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${step}`);
      const first = (data.result as Array<{ values: Array<[number, string]> }>)[0];
      return (first?.values ?? []).map(([at, value]) => [at, Number(value)] as [number, number]).filter(([, value]) => Number.isFinite(value));
    },
    async alerts() {
      const data = await get('alerts');
      return data.alerts as PromAlert[];
    },
  };
}

export interface Viewer {
  id: string;
  isAdmin?: boolean | undefined;
}

export type MonitoringStore = Pick<Database, 'infrastructure' | 'releases' | 'monitoring'>;

export interface MonitoringDeps {
  store: MonitoringStore;
  systemCluster(): Promise<ClusterMetadata | undefined>;
  ownsSystem(viewer: Viewer): boolean;
  prometheus(cluster: ClusterMetadata): Promise<PrometheusClient>;
  pool?(cluster: ClusterMetadata): PoolMonitor | undefined;
  kubectl(cluster: ClusterMetadata, args: string[]): Promise<string>;
  apply(cluster: ClusterMetadata, manifest: string): Promise<void>;
  helm(cluster: ClusterMetadata, args: string[]): Promise<string>;
  now?: () => Date;
  newId?: () => string;
}

export interface HistoryState {
  days: number;
  kept?: number | undefined;
  applied: boolean;
  problem?: string | undefined;
  canChange: boolean;
  byKoala?: boolean | undefined;
}

export interface AppRow {
  id: string;
  name: string;
  appType?: string | undefined;
  clusterId: string;
  clusterName: string;
  state: HealthState;
  reasons: string[];
  numbers: AppNumbers;
  memoryShare?: number | undefined;
  cpuShare?: number | undefined;
  url?: string | undefined;
}

export interface ClusterRow {
  id: string;
  name: string;
  state: HealthState;
  reasons: string[];
  numbers: ClusterNumbers;
  history: HistoryState;
  apps: number;
  isSystem: boolean;
}

export interface Attention {
  subject: { kind: 'app' | 'cluster'; id: string; name: string };
  state: HealthState;
  reasons: string[];
}

export interface Overview {
  attention: Attention[];
  apps: AppRow[];
  clusters: ClusterRow[];
  firing: Array<VisibleAlert & { clusterId: string }>;
  checkedAt: string;
}

export interface Marker {
  at: string;
  label: string;
}

export interface Series {
  chart: string;
  points: Array<[number, number]>;
}

export interface AppHealthView {
  app: AppRow;
  lines: string[];
  range: Range;
  series: Series[];
  markers: Marker[];
  firing: VisibleAlert[];
  episodes: AlertEpisode[];
  rules: AlertRuleRecord[];
  history: HistoryState;
}

export interface ClusterHealthView {
  cluster: ClusterRow;
  lines: string[];
  range: Range;
  series: Series[];
  firing: VisibleAlert[];
  episodes: AlertEpisode[];
  apps: AppRow[];
}

interface Reached {
  cluster: ClusterMetadata;
  state: HealthState;
  reason?: string | undefined;
  metrics?: MetricsClient | undefined;
}

export class MonitoringError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const first = (samples: Sample[]): number | undefined => (samples[0] && Number.isFinite(samples[0].value) ? samples[0].value : undefined);

const COUNTED: ReadonlySet<string> = new Set(['probed', 'podsRunning', 'podsBroken', 'nodesNotReady', 'podsPending']);

export const namespaceOf = (dep: Pick<DeploymentMetadata, 'name' | 'namespace'>): string => dep.namespace || sanitizeNamespace(dep.name);

export class MonitoringService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: MonitoringDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  ownsCluster(viewer: Viewer, cluster: ClusterMetadata): boolean {
    return cluster.isSystem ? this.deps.ownsSystem(viewer) : cluster.ownerId === viewer.id;
  }

  async clustersOf(viewer: Viewer): Promise<ClusterMetadata[]> {
    const system = await this.deps.systemCluster();
    const own = (await this.deps.store.infrastructure.getClusters()).filter((cluster) => cluster.ownerId === viewer.id && cluster.status !== 'destroying');
    return [...(system ? [system] : []), ...own];
  }

  async appsOf(viewer: Viewer): Promise<DeploymentMetadata[]> {
    return (await this.deps.store.infrastructure.getDeployments()).filter((dep) => dep.ownerId === viewer.id && dep.status !== 'destroying');
  }

  async allClusters(): Promise<ClusterMetadata[]> {
    const system = await this.deps.systemCluster();
    return [...(system ? [system] : []), ...(await this.deps.store.infrastructure.getClusters()).filter((cluster) => cluster.status === 'healthy')];
  }

  async reach(cluster: ClusterMetadata): Promise<Reached> {
    if (cluster.status === 'provisioning') return { cluster, state: 'installing', reason: 'it is being made' };
    if (cluster.status !== 'healthy') return { cluster, state: 'unreachable', reason: `it is ${cluster.status}` };
    const pool = this.deps.pool?.(cluster);
    if (pool) {
      try {
        await pool.ask({ kind: 'cluster', question: 'nodes' });
        return { cluster, state: 'ok', metrics: pool };
      } catch (err) {
        return { cluster, state: 'unreachable', reason: `Koala's servers do not answer about it (${(err as Error).message})` };
      }
    }
    try {
      const prometheus = await this.deps.prometheus(cluster);
      await prometheus.query('vector(1)');
      return { cluster, state: 'ok', metrics: metricsOf(prometheus) };
    } catch (err) {
      const monitoring = await this.deps.kubectl(cluster, ['get', 'service', 'kube-prometheus-stack-prometheus', '-n', 'monitoring', '--ignore-not-found', '-o', 'name']).catch(() => undefined);
      if (monitoring === undefined) return { cluster, state: 'unreachable', reason: 'it does not answer' };
      if (monitoring.trim() === '') return { cluster, state: 'installing', reason: 'its monitoring is installed before its next app is deployed' };
      return { cluster, state: 'unreachable', reason: `its Prometheus does not answer (${(err as Error).message})` };
    }
  }

  private async settingOf(clusterId: string): Promise<MonitoringSetting | undefined> {
    return (await this.deps.store.monitoring.getMonitoringSettings()).find((setting) => setting.clusterId === clusterId);
  }

  async historyOf(viewer: Viewer | undefined, cluster: ClusterMetadata, reached?: Reached): Promise<HistoryState> {
    const setting = await this.settingOf(cluster.id);
    const days = setting?.historyDays ?? DEFAULT_HISTORY_DAYS;
    const pool = this.deps.pool?.(cluster);
    if (pool) {
      const kept = await pool.history().catch(() => undefined);
      return { days: kept?.days ?? DEFAULT_HISTORY_DAYS, kept: kept?.kept, applied: true, canChange: false, byKoala: true };
    }
    const canChange = viewer ? this.ownsCluster(viewer, cluster) : false;
    if (reached && reached.state !== 'ok') return { days, applied: false, canChange, ...(setting?.problem ? { problem: setting.problem } : {}) };
    const now = await this.prometheusResource(cluster).catch(() => undefined);
    return {
      days,
      kept: keptDays(now?.retention),
      applied: now ? historyApplied(now, days) : false,
      canChange,
      ...(setting?.problem ? { problem: setting.problem } : {}),
    };
  }

  private async prometheusResource(cluster: ClusterMetadata) {
    const json = await this.deps.kubectl(cluster, ['get', 'prometheus', 'kube-prometheus-stack-prometheus', '-n', 'monitoring', '-o', 'json']);
    return prometheusNow(JSON.parse(json));
  }

  async servicesOf(metrics: MetricsClient, namespace: string): Promise<string[]> {
    const samples = await metrics.ask({ kind: 'services', namespace }).catch(() => []);
    return [...new Set(samples.map((sample) => sample.metric.service).filter((name): name is string => Boolean(name)))];
  }

  async appNumbers(metrics: MetricsClient, subject: AppSubject, kept: number): Promise<AppNumbers> {
    const numbers: AppNumbers = {};
    await Promise.all([
      ...APP_QUESTIONS.map(async (question) => {
        const value = first(await metrics.ask({ kind: 'app', question, subject }).catch(() => []));
        numbers[question] = value ?? (COUNTED.has(question) ? 0 : undefined);
      }),
      ...([['uptimeDay', 'uptime', 86_400], ['uptimeWeek', 'uptime', 604_800], ['uptimeKept', 'uptime', kept * 86_400], ['restartsDay', 'restarts', 86_400]] as const).map(async ([key, question, seconds]) => {
        numbers[key] = first(await metrics.ask({ kind: 'window', question, subject, seconds }).catch(() => []));
      }),
    ]);
    if (!numbers.probed) {
      delete numbers.uptimeDay;
      delete numbers.uptimeWeek;
      delete numbers.uptimeKept;
    }
    return numbers;
  }

  async clusterNumbers(metrics: MetricsClient): Promise<ClusterNumbers> {
    const numbers: ClusterNumbers = {};
    await Promise.all(CLUSTER_QUESTIONS.map(async (question) => {
      const value = first(await metrics.ask({ kind: 'cluster', question }).catch(() => []));
      numbers[question] = value ?? (COUNTED.has(question) ? 0 : undefined);
    }));
    return numbers;
  }

  private async scopeFor(viewer: Viewer, cluster: ClusterMetadata, apps: DeploymentMetadata[]) {
    const rules = await this.deps.store.monitoring.getAlertRules(viewer.id);
    return {
      appsByNamespace: new Map(apps.filter((dep) => dep.clusterId === cluster.id).map((dep) => [namespaceOf(dep), { deploymentId: dep.id, name: dep.name }])),
      ownRules: new Set(rules.map((rule) => rule.id)),
      ownsCluster: this.ownsCluster(viewer, cluster),
    };
  }

  async firingOn(viewer: Viewer, reached: Reached, apps: DeploymentMetadata[]): Promise<VisibleAlert[]> {
    if (!reached.metrics) return [];
    const alerts = await reached.metrics.alerts().catch(() => []);
    return visibleAlerts(alerts, await this.scopeFor(viewer, reached.cluster, apps));
  }

  private async appRow(dep: DeploymentMetadata, reached: Reached, firing: VisibleAlert[], kept: number): Promise<AppRow> {
    const base = { id: dep.id, name: dep.name, ...(dep.appType ? { appType: dep.appType } : {}), clusterId: reached.cluster.id, clusterName: reached.cluster.name, ...(dep.publicExposureUrl ? { url: dep.publicExposureUrl } : {}) };
    if (dep.status === 'deploying') return { ...base, state: 'installing', reasons: ['it is being deployed'], numbers: {} };
    if (dep.status === 'failed') return { ...base, state: 'down', reasons: ['its deploy failed'], numbers: {} };
    if (!reached.metrics) return { ...base, state: reached.state, reasons: reached.reason ? [`its cluster ${reached.reason}`] : [], numbers: {} };
    const namespace = namespaceOf(dep);
    const numbers = await this.appNumbers(reached.metrics, { namespace, services: await this.servicesOf(reached.metrics, namespace) }, kept);
    const verdict = appVerdict(numbers, firing.filter((alert) => alert.about.kind === 'app' && alert.about.deploymentId === dep.id).map((alert) => alert.summary));
    return { ...base, ...verdict, numbers, memoryShare: share(numbers.memoryBytes, numbers.memoryLimitBytes), cpuShare: share(numbers.cpuCores, numbers.cpuLimitCores) };
  }

  private async clusterRow(viewer: Viewer, reached: Reached, firing: VisibleAlert[], apps: number): Promise<ClusterRow> {
    const history = await this.historyOf(viewer, reached.cluster, reached);
    const base = { id: reached.cluster.id, name: reached.cluster.name, history, apps, isSystem: Boolean(reached.cluster.isSystem) };
    if (!reached.metrics) return { ...base, state: reached.state, reasons: reached.reason ? [reached.reason] : [], numbers: {} };
    const numbers = await this.clusterNumbers(reached.metrics);
    const verdict = clusterVerdict(numbers, firing.filter((alert) => alert.about.kind === 'cluster').map((alert) => alert.summary), this.isPool(reached.cluster));
    return { ...base, ...verdict, numbers };
  }

  async overview(viewer: Viewer): Promise<Overview> {
    const [clusters, apps] = await Promise.all([this.clustersOf(viewer), this.appsOf(viewer)]);
    const per = await Promise.all(clusters.map(async (cluster) => {
      const reached = await this.reach(cluster);
      const firing = await this.firingOn(viewer, reached, apps);
      const history = await this.historyOf(viewer, cluster, reached);
      const kept = history.kept ?? history.days;
      const mine = apps.filter((dep) => dep.clusterId === cluster.id);
      const rows = await Promise.all(mine.map((dep) => this.appRow(dep, reached, firing, kept)));
      const row = await this.clusterRow(viewer, reached, firing, mine.length);
      return { row, rows, firing: firing.map((alert) => ({ ...alert, clusterId: cluster.id })) };
    }));
    const appRows = worstFirst(per.flatMap((entry) => entry.rows));
    const clusterRows = worstFirst(per.map((entry) => entry.row).filter((row) => row.apps > 0 || !row.isSystem || this.deps.ownsSystem(viewer)));
    const attention = worstFirst([
      ...clusterRows.filter((row) => row.state !== 'ok').map((row) => ({ subject: { kind: 'cluster' as const, id: row.id, name: row.name }, state: row.state, reasons: row.reasons, name: row.name })),
      ...appRows.filter((row) => row.state !== 'ok').map((row) => ({ subject: { kind: 'app' as const, id: row.id, name: row.name }, state: row.state, reasons: row.reasons, name: row.name })),
    ]).map(({ name: _name, ...entry }) => entry);
    return { attention, apps: appRows, clusters: clusterRows, firing: per.flatMap((entry) => entry.firing), checkedAt: this.now().toISOString() };
  }

  private window(range: Range) {
    const end = Math.floor(this.now().getTime() / 1000);
    return { start: end - RANGE_SECONDS[range], end, step: stepFor(range) };
  }

  private async markersFor(viewer: Viewer, dep: DeploymentMetadata, since: number): Promise<Marker[]> {
    const runs = (await this.deps.store.releases.getPipelineRuns()).filter((run) => run.promotedAt && (run.deploymentId === dep.id || (dep.gitappProjectId && run.projectId === dep.gitappProjectId)));
    const releases = dep.gitappProjectId ? await this.deps.store.releases.getOdooReleases(viewer.id, dep.gitappProjectId) : [];
    const markers: Marker[] = [
      ...runs.map((run) => ({ at: run.promotedAt!, label: `deployed ${run.commitSha?.slice(0, 8) ?? ''}`.trim() })),
      ...releases.filter((release) => release.liveAt).map((release) => ({ at: release.liveAt!, label: `release ${release.slot ?? ''} live`.replace('  ', ' ') })),
    ];
    return markers.filter((marker) => Date.parse(marker.at) / 1000 >= since).sort((a, b) => a.at.localeCompare(b.at));
  }

  async appHealth(viewer: Viewer, deploymentId: string, range: Range): Promise<AppHealthView> {
    const apps = await this.appsOf(viewer);
    const dep = apps.find((entry) => entry.id === deploymentId);
    if (!dep) throw new MonitoringError(404, 'no such app');
    const cluster = (await this.clustersOf(viewer)).find((entry) => entry.id === dep.clusterId);
    if (!cluster) throw new MonitoringError(404, 'the app\'s cluster is gone');
    const reached = await this.reach(cluster);
    const firing = (await this.firingOn(viewer, reached, apps)).filter((alert) => alert.about.kind === 'app' && alert.about.deploymentId === dep.id);
    const history = await this.historyOf(viewer, cluster, reached);
    const kept = history.kept ?? history.days;
    const row = await this.appRow(dep, reached, firing, kept);
    const window = this.window(range);
    const series: Series[] = [];
    if (reached.metrics) {
      const metrics = reached.metrics;
      const namespace = namespaceOf(dep);
      const subject = { namespace, services: await this.servicesOf(metrics, namespace) };
      await Promise.all(APP_CHARTS.map(async (chart: AppChart) => {
        const points = await metrics.askRange({ kind: 'appChart', chart, subject }, window).catch(() => []);
        if (points.length) series.push({ chart, points });
      }));
    }
    series.sort((a, b) => APP_CHARTS.indexOf(a.chart as AppChart) - APP_CHARTS.indexOf(b.chart as AppChart));
    const episodes = (await this.deps.store.monitoring.getAlertEpisodes(viewer.id)).filter((episode) => episode.about.kind === 'app' && episode.about.deploymentId === dep.id).slice(0, 50);
    const rules = (await this.deps.store.monitoring.getAlertRules(viewer.id)).filter((rule) => rule.deploymentId === dep.id);
    return {
      app: row,
      lines: appLines(dep.name, row, row.numbers, kept),
      range,
      series,
      markers: await this.markersFor(viewer, dep, window.start),
      firing,
      episodes,
      rules,
      history,
    };
  }

  async clusterHealth(viewer: Viewer, clusterId: string, range: Range): Promise<ClusterHealthView> {
    const cluster = (await this.clustersOf(viewer)).find((entry) => entry.id === clusterId);
    if (!cluster) throw new MonitoringError(404, 'no such cluster');
    const apps = await this.appsOf(viewer);
    const reached = await this.reach(cluster);
    const firing = await this.firingOn(viewer, reached, apps);
    const mine = apps.filter((dep) => dep.clusterId === cluster.id);
    const history = await this.historyOf(viewer, cluster, reached);
    const rows = worstFirst(await Promise.all(mine.map((dep) => this.appRow(dep, reached, firing, history.kept ?? history.days))));
    const row = await this.clusterRow(viewer, reached, firing, mine.length);
    const window = this.window(range);
    const series: Series[] = [];
    if (reached.metrics) {
      const metrics = reached.metrics;
      await Promise.all(CLUSTER_CHARTS.map(async (chart: ClusterChart) => {
        const points = await metrics.askRange({ kind: 'clusterChart', chart }, window).catch(() => []);
        if (points.length) series.push({ chart, points });
      }));
    }
    series.sort((a, b) => CLUSTER_CHARTS.indexOf(a.chart as ClusterChart) - CLUSTER_CHARTS.indexOf(b.chart as ClusterChart));
    const episodes = (await this.deps.store.monitoring.getAlertEpisodes(viewer.id)).filter((episode) => episode.clusterId === cluster.id).slice(0, 50);
    return {
      cluster: row,
      lines: clusterLines(cluster.name, row, row.numbers, this.isPool(cluster)),
      range,
      series,
      firing: firing.filter((alert) => alert.about.kind === 'cluster'),
      episodes,
      apps: rows,
    };
  }

  async alerts(viewer: Viewer): Promise<{ firing: Overview['firing']; episodes: AlertEpisode[]; rules: AlertRuleRecord[] }> {
    const [clusters, apps] = await Promise.all([this.clustersOf(viewer), this.appsOf(viewer)]);
    const firing = (await Promise.all(clusters.map(async (cluster) => {
      const reached = await this.reach(cluster);
      return (await this.firingOn(viewer, reached, apps)).map((alert) => ({ ...alert, clusterId: cluster.id }));
    }))).flat();
    return { firing, episodes: (await this.deps.store.monitoring.getAlertEpisodes(viewer.id)).slice(0, 100), rules: await this.deps.store.monitoring.getAlertRules(viewer.id) };
  }

  async setHistory(viewer: Viewer, clusterId: string, days: unknown): Promise<HistoryState> {
    const problem = historyProblem(days);
    if (problem) throw new MonitoringError(400, problem);
    const cluster = (await this.clustersOf(viewer)).find((entry) => entry.id === clusterId);
    if (!cluster) throw new MonitoringError(404, 'no such cluster');
    if (!this.ownsCluster(viewer, cluster)) throw new MonitoringError(403, 'only whoever owns this cluster can change how long it keeps history');
    if (this.deps.pool?.(cluster)) throw new MonitoringError(409, 'Koala\'s servers keep this history, for as long as they keep everyone\'s');
    await this.deps.store.monitoring.saveMonitoringSetting({ clusterId, ownerId: viewer.id, historyDays: days as number, updatedAt: this.now().toISOString() });
    await this.applyHistory(cluster);
    return this.historyOf(viewer, cluster);
  }

  private async expressionFor(cluster: ClusterMetadata, metrics: MetricsClient, namespace: string, spec: AlertSpec): Promise<string | { error: string }> {
    if (this.deps.pool?.(cluster)) return alertExpression(spec, { namespace }, { hostNamespace: 'pool' });
    return alertExpression(spec, { namespace, services: await this.servicesOf(metrics, namespace) });
  }

  private readonly probesSent = new Map<string, string>();

  async syncPoolProbes(cluster: ClusterMetadata): Promise<void> {
    const pool = this.deps.pool?.(cluster);
    if (!pool) return;
    const probes = probesFromCluster(await this.deps.kubectl(cluster, ['get', 'probes.monitoring.coreos.com', '--all-namespaces', '-o', 'json']));
    const key = probesKey(probes);
    if (this.probesSent.get(cluster.id) === key) return;
    await pool.setProbes(probes);
    this.probesSent.set(cluster.id, key);
  }

  isPool(cluster: ClusterMetadata): boolean {
    return Boolean(this.deps.pool?.(cluster));
  }

  async applyHistory(cluster: ClusterMetadata): Promise<boolean> {
    if (this.isPool(cluster)) return false;
    const setting = await this.settingOf(cluster.id);
    const days = setting?.historyDays ?? DEFAULT_HISTORY_DAYS;
    const now = await this.prometheusResource(cluster).catch(() => undefined);
    if (!now || historyApplied(now, days)) return false;
    try {
      const releases = JSON.parse(await this.deps.helm(cluster, ['list', '-n', 'monitoring', '-o', 'json'])) as Array<{ name?: string; chart?: string }>;
      const version = chartVersionOf(releases);
      if (!version) throw new Error('kube-prometheus-stack is not installed by Helm on this cluster');
      await this.deps.helm(cluster, helmHistoryArgs(days, version));
      if (setting) await this.deps.store.monitoring.saveMonitoringSetting({ ...setting, appliedAt: this.now().toISOString(), problem: undefined });
      return true;
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      await this.deps.store.monitoring.saveMonitoringSetting({ clusterId: cluster.id, ownerId: setting?.ownerId ?? cluster.ownerId ?? 'platform', historyDays: days, updatedAt: setting?.updatedAt ?? this.now().toISOString(), problem: message });
      return false;
    }
  }

  async applyRequestMetrics(cluster: ClusterMetadata): Promise<'applied' | 'already' | { problem: string }> {
    const releases = JSON.parse(await this.deps.helm(cluster, ['list', '-A', '-o', 'json'])) as HelmRelease[];
    const traefik = traefikOf(releases);
    if (traefik.kind === 'none') return { problem: 'the cluster has no Traefik, so requests cannot be counted' };
    if (traefik.kind === 'ours') {
      const values = JSON.parse(await this.deps.helm(cluster, ['get', 'values', 'traefik', '-n', 'traefik', '-o', 'json']));
      if (servicesLabelled(values)) return 'already';
      await this.deps.helm(cluster, ourTraefikArgs(traefik.version));
      return 'applied';
    }
    const existing = await this.deps.kubectl(cluster, ['get', 'helmchartconfig', 'traefik', '-n', 'kube-system', '--ignore-not-found', '-o', 'json']);
    const state = k3sConfigState(existing.trim() ? JSON.parse(existing) : undefined);
    if (state === 'ours') return 'already';
    if (state === 'theirs') return { problem: 'k3s\'s Traefik has settings of its own here, so request counting was not switched on' };
    await this.deps.apply(cluster, JSON.stringify(K3S_TRAEFIK_CONFIG));
    return 'applied';
  }

  async describeApp(viewer: Viewer, nameOrId: string): Promise<string> {
    const apps = await this.appsOf(viewer);
    const wanted = nameOrId.trim().toLowerCase();
    const dep = apps.find((entry) => entry.id === nameOrId) ?? apps.find((entry) => entry.name.toLowerCase() === wanted);
    if (!dep) throw new MonitoringError(404, `no app called ${nameOrId}; yours are: ${apps.map((entry) => entry.name).join(', ') || 'none'}`);
    const view = await this.appHealth(viewer, dep.id, '24h');
    const lines = [...view.lines];
    if (view.firing.length) lines.push(`Firing now: ${view.firing.map((alert) => alert.summary).join('; ')}.`);
    const recent = view.episodes.filter((episode) => episode.resolvedAt).slice(0, 5);
    if (recent.length) lines.push(`Recent alerts: ${recent.map((episode) => `${episode.summary} (${episode.startedAt} to ${episode.resolvedAt})`).join('; ')}.`);
    lines.push(view.rules.length ? `Alerts set: ${view.rules.map((rule) => `${rule.summary} [${rule.id}]`).join('; ')}.` : 'No alerts of the person\'s own are set on it.');
    if (view.markers.length) lines.push(`Releases in the last day: ${view.markers.map((marker) => `${marker.label} at ${marker.at}`).join('; ')}.`);
    lines.push(`Its cluster keeps ${view.history.kept ?? view.history.days} days of history.`);
    return lines.join('\n');
  }

  async describeCluster(viewer: Viewer, nameOrId: string): Promise<string> {
    const clusters = await this.clustersOf(viewer);
    const wanted = nameOrId.trim().toLowerCase();
    const cluster = clusters.find((entry) => entry.id === nameOrId) ?? clusters.find((entry) => entry.name.toLowerCase() === wanted);
    if (!cluster) throw new MonitoringError(404, `no cluster called ${nameOrId}; yours are: ${clusters.map((entry) => entry.name).join(', ')}`);
    const view = await this.clusterHealth(viewer, cluster.id, '24h');
    const lines = [...view.lines];
    if (view.firing.length) lines.push(`Firing now: ${view.firing.map((alert) => alert.summary).join('; ')}.`);
    lines.push(view.apps.length ? `Apps on it: ${view.apps.map((app) => `${app.name} (${app.state})`).join(', ')}.` : 'No apps of the person\'s run on it.');
    const history = view.cluster.history;
    lines.push(`It keeps ${history.kept ?? history.days} days of history${history.applied ? '' : `; ${history.days} days are wanted and not applied yet${history.problem ? ` (${history.problem})` : ''}`}.`);
    return lines.join('\n');
  }

  async describeOverview(viewer: Viewer): Promise<string> {
    const overview = await this.overview(viewer);
    const lines: string[] = [];
    lines.push(overview.attention.length
      ? `Needs attention:\n${overview.attention.map((item) => `- ${item.subject.kind} ${item.subject.name}: ${item.state}${item.reasons.length ? ` (${item.reasons.join('; ')})` : ''}`).join('\n')}`
      : 'Nothing needs attention.');
    lines.push(`Apps:\n${overview.apps.map((app) => `- ${app.name} on ${app.clusterName}: ${app.state}`).join('\n') || '- none'}`);
    lines.push(`Clusters:\n${overview.clusters.map((cluster) => `- ${cluster.name}: ${cluster.state}, ${cluster.apps} app${cluster.apps === 1 ? '' : 's'}`).join('\n') || '- none'}`);
    return lines.join('\n\n');
  }

  async proposeAlertProblem(viewer: Viewer, appNameOrId: string, spec: AlertSpec): Promise<{ dep: DeploymentMetadata; summary: string } | { error: string }> {
    const apps = await this.appsOf(viewer);
    const wanted = appNameOrId.trim().toLowerCase();
    const dep = apps.find((entry) => entry.id === appNameOrId) ?? apps.find((entry) => entry.name.toLowerCase() === wanted);
    if (!dep) return { error: `no app called ${appNameOrId}; yours are: ${apps.map((entry) => entry.name).join(', ') || 'none'}` };
    const cluster = (await this.clustersOf(viewer)).find((entry) => entry.id === dep.clusterId);
    if (!cluster) return { error: 'the app\'s cluster is gone' };
    const reached = await this.reach(cluster);
    if (!reached.metrics) return { error: `its cluster ${reached.reason ?? 'cannot be reached'}, so an alert cannot be set there now` };
    const expression = await this.expressionFor(cluster, reached.metrics, namespaceOf(dep), spec);
    if (typeof expression !== 'string') return expression;
    return { dep, summary: `Tell me when ${ALERT_RULES[spec.kind].describe(dep.name, spec)}` };
  }

  async addRule(viewer: Viewer, deploymentId: string, spec: AlertSpec, conversationId?: string): Promise<AlertRuleRecord> {
    const dep = (await this.appsOf(viewer)).find((entry) => entry.id === deploymentId);
    if (!dep) throw new MonitoringError(404, 'no such app');
    const cluster = (await this.clustersOf(viewer)).find((entry) => entry.id === dep.clusterId);
    if (!cluster) throw new MonitoringError(404, 'the app\'s cluster is gone');
    const reached = await this.reach(cluster);
    if (!reached.metrics) throw new MonitoringError(409, `its cluster ${reached.reason ?? 'cannot be reached'}`);
    const namespace = namespaceOf(dep);
    const expression = await this.expressionFor(cluster, reached.metrics, namespace, spec);
    if (typeof expression !== 'string') throw new MonitoringError(400, expression.error);
    const rule: AlertRuleRecord = {
      id: this.newId(),
      ownerId: viewer.id,
      deploymentId: dep.id,
      clusterId: cluster.id,
      namespace,
      appName: dep.name,
      spec,
      summary: alertSummary(dep.name, spec),
      ...(conversationId ? { conversationId } : {}),
      createdAt: this.now().toISOString(),
    };
    const pool = this.deps.pool?.(cluster);
    if (pool) await pool.setRule({ id: rule.id, namespace, spec, summary: rule.summary });
    else await this.deps.apply(cluster, JSON.stringify(alertRuleManifest(rule, expression)));
    await this.deps.store.monitoring.saveAlertRule(rule);
    return rule;
  }

  async removeRule(viewer: Viewer, ruleId: string): Promise<void> {
    const rule = (await this.deps.store.monitoring.getAlertRules(viewer.id)).find((entry) => entry.id === ruleId);
    if (!rule) throw new MonitoringError(404, 'no such alert');
    const cluster = (await this.clustersOf(viewer)).find((entry) => entry.id === rule.clusterId);
    const pool = cluster ? this.deps.pool?.(cluster) : undefined;
    if (pool) await pool.removeRule(rule.id);
    else if (cluster) await this.deps.kubectl(cluster, ['delete', 'prometheusrule', ruleResourceName(rule.id), '-n', rule.namespace, '--ignore-not-found']);
    await this.deps.store.monitoring.deleteAlertRule(rule.id);
  }
}
