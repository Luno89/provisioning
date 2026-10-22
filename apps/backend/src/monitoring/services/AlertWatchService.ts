import { randomUUID } from 'node:crypto';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import { visibleAlerts, type AlertRuleRecord, type PromAlert, type VisibleAlert } from '../lib/monitoring-alerts.js';
import type { AlertEpisode } from '../lib/monitoring-records.js';
import { namespaceOf, type MonitoringService } from './MonitoringService.js';
import type { Database } from '../../platform/lib/db-interface.js';

export const WATCH_EVERY_MS = 30_000;
export const HISTORY_RETRY_MS = 10 * 60_000;

export type AlertChange = 'fired' | 'resolved';

export interface AlertWatchDeps {
  monitoring: Pick<MonitoringService, 'allClusters' | 'reach' | 'applyHistory' | 'applyRequestMetrics' | 'syncPoolProbes'>;
  store: Pick<Database, 'getDeployments' | 'getAlertRules' | 'getAlertEpisodes' | 'saveAlertEpisode'>;
  systemOwners(): Promise<string[]>;
  tell(episode: AlertEpisode, change: AlertChange, context: { app?: DeploymentMetadata | undefined; rule?: AlertRuleRecord | undefined }): Promise<void>;
  log?: (message: string) => void;
  now?: () => Date;
  newId?: () => string;
}

export class AlertWatchService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly historyTried = new Map<string, number>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: AlertWatchDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  start(everyMs = WATCH_EVERY_MS): void {
    if (this.timer) return;
    const tick = () => { void this.tick(); };
    this.timer = setInterval(tick, everyMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.watch().catch((err) => this.deps.log?.(`[alerts] ${(err as Error).message}`)).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async watch(): Promise<void> {
    const clusters = await this.deps.monitoring.allClusters();
    const apps = (await this.deps.store.getDeployments()).filter((dep) => dep.status !== 'destroying');
    const rules = await this.deps.store.getAlertRules();
    const systemOwners = await this.deps.systemOwners();
    for (const cluster of clusters) {
      const reached = await this.deps.monitoring.reach(cluster);
      if (!reached.metrics) continue;
      await this.deps.monitoring.syncPoolProbes(cluster).catch((err: Error) => this.deps.log?.(`[alerts] ${cluster.name}: its probes were not handed to Koala's servers (${err.message})`));
      await this.reconcileHistory(cluster);
      const alerts = await reached.metrics.alerts().catch(() => undefined);
      if (!alerts) continue;
      const onCluster = apps.filter((dep) => dep.clusterId === cluster.id);
      const owners = new Set<string>([
        ...onCluster.map((dep) => dep.ownerId).filter((id): id is string => Boolean(id)),
        ...(cluster.isSystem ? systemOwners : cluster.ownerId ? [cluster.ownerId] : []),
      ]);
      for (const owner of owners) await this.settle(owner, cluster, alerts, onCluster, rules, systemOwners);
    }
  }

  private async reconcileHistory(cluster: ClusterMetadata): Promise<void> {
    const last = this.historyTried.get(cluster.id);
    if (last !== undefined && this.now().getTime() - last < HISTORY_RETRY_MS) return;
    this.historyTried.set(cluster.id, this.now().getTime());
    const changed = await this.deps.monitoring.applyHistory(cluster).catch(() => false);
    if (changed) this.deps.log?.(`[alerts] ${cluster.name} now keeps the history it was set to`);
    const counting = await this.deps.monitoring.applyRequestMetrics(cluster).catch((err: Error) => ({ problem: err.message }));
    if (counting === 'applied') this.deps.log?.(`[alerts] ${cluster.name} now counts each app's requests`);
    else if (typeof counting === 'object') this.deps.log?.(`[alerts] ${cluster.name}: ${counting.problem}`);
  }

  private async settle(owner: string, cluster: ClusterMetadata, alerts: PromAlert[], onCluster: DeploymentMetadata[], rules: AlertRuleRecord[], systemOwners: string[]): Promise<void> {
    const mine = onCluster.filter((dep) => dep.ownerId === owner);
    const visible = visibleAlerts(alerts, {
      appsByNamespace: new Map(mine.map((dep) => [namespaceOf(dep), { deploymentId: dep.id, name: dep.name }])),
      ownRules: new Set(rules.filter((rule) => rule.ownerId === owner).map((rule) => rule.id)),
      ownsCluster: cluster.isSystem ? systemOwners.includes(owner) : cluster.ownerId === owner,
    });
    const open = (await this.deps.store.getAlertEpisodes(owner)).filter((episode) => episode.clusterId === cluster.id && !episode.resolvedAt);
    const at = this.now().toISOString();
    for (const alert of visible) {
      if (open.some((episode) => episode.key === alert.key)) continue;
      const episode = this.episodeOf(owner, cluster, alert, at);
      await this.deps.store.saveAlertEpisode(episode);
      await this.tellAbout(episode, 'fired', mine, rules);
    }
    for (const episode of open) {
      if (visible.some((alert) => alert.key === episode.key)) continue;
      const resolved = { ...episode, resolvedAt: at };
      await this.deps.store.saveAlertEpisode(resolved);
      await this.tellAbout(resolved, 'resolved', mine, rules);
    }
  }

  private episodeOf(owner: string, cluster: ClusterMetadata, alert: VisibleAlert, at: string): AlertEpisode {
    return {
      id: this.newId(),
      ownerId: owner,
      clusterId: cluster.id,
      key: alert.key,
      name: alert.name,
      summary: alert.summary,
      about: alert.about,
      ...(alert.ruleId ? { ruleId: alert.ruleId } : {}),
      startedAt: alert.since ?? at,
    };
  }

  private async tellAbout(episode: AlertEpisode, change: AlertChange, mine: DeploymentMetadata[], rules: AlertRuleRecord[]): Promise<void> {
    const about = episode.about;
    const app = about.kind === 'app' ? mine.find((dep) => dep.id === about.deploymentId) : undefined;
    const rule = episode.ruleId ? rules.find((entry) => entry.id === episode.ruleId) : undefined;
    await this.deps.tell(episode, change, { app, rule }).catch((err) => this.deps.log?.(`[alerts] could not tell ${episode.ownerId}: ${(err as Error).message}`));
  }
}
