import { askQuery, type MonitoringAsk, type RangeAsk } from '../lib/monitoring-asks.js';
import type { PoolPlace } from '../lib/monitoring-questions.js';
import { VIRTUAL_NAMESPACE_LABEL } from '../lib/monitoring-questions.js';
import { ruleResourceName, type PromAlert } from '../lib/monitoring-alerts.js';
import {
  hostProbeManifest, hostRuleManifest, placeAlerts, POOL_MONITORING, POOL_PROBE_LABEL, probeResourceName,
  type PoolProbe, type PoolRule,
} from '../lib/pool-monitoring.js';
import { prometheusAt, type PrometheusClient, type Sample } from './MonitoringService.js';

export interface PoolMonitoringDeps {
  kubectl(args: string[]): Promise<string>;
  apply(manifest: string): Promise<void>;
}

export class PoolMonitoringError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface ServiceJson {
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
}

export function prometheusThroughApi(kubectl: PoolMonitoringDeps['kubectl']): PrometheusClient {
  const base = `/api/v1/namespaces/${POOL_MONITORING.namespace}/services/${POOL_MONITORING.prometheusService}/proxy/`;
  return prometheusAt(base, (async (url: string) => new Response(await kubectl(['get', '--raw', url]), { status: 200 })) as unknown as typeof fetch);
}

export class PoolMonitoringService {
  private readonly prometheus: PrometheusClient;

  constructor(private readonly deps: PoolMonitoringDeps) {
    this.prometheus = prometheusThroughApi(deps.kubectl);
  }

  history(): { days: number; kept: number } {
    return { days: POOL_MONITORING.historyDays, kept: POOL_MONITORING.historyDays };
  }

  async ask(place: PoolPlace, ask: MonitoringAsk): Promise<Sample[]> {
    const query = askQuery(ask, place);
    if (!query) return [];
    const samples = await this.prometheus.query(query);
    return ask.kind === 'usage' ? samples.filter((sample) => sample.metric.namespace && sample.metric.namespace !== place.hostNamespace) : samples;
  }

  async askRange(place: PoolPlace, ask: MonitoringAsk, range: RangeAsk): Promise<Array<[number, number]>> {
    const query = askQuery(ask, place);
    return query ? this.prometheus.range(query, range.start, range.end, range.step) : [];
  }

  async alerts(place: PoolPlace): Promise<PromAlert[]> {
    const [alerts, pods] = await Promise.all([
      this.prometheus.alerts(),
      this.prometheus.query(`kube_pod_labels{namespace=${JSON.stringify(place.hostNamespace)}}`),
    ]);
    const namespaceOfPod = new Map(pods.map((sample) => [sample.metric.pod ?? '', sample.metric[VIRTUAL_NAMESPACE_LABEL] ?? '']).filter(([pod, ns]) => pod && ns) as Array<[string, string]>);
    return placeAlerts(alerts, place, namespaceOfPod);
  }

  async setProbes(name: string, place: PoolPlace, probes: readonly PoolProbe[]): Promise<{ probed: number; missing: string[] }> {
    const services = JSON.parse(await this.deps.kubectl(['get', 'services', '-n', place.hostNamespace, '-l', `vcluster.loft.sh/managed-by=${name}`, '-o', 'json'])) as { items?: ServiceJson[] };
    const hostName = new Map<string, string>();
    for (const item of services.items ?? []) {
      const annotations = item.metadata?.annotations ?? {};
      const virtual = `${annotations['vcluster.loft.sh/object-namespace'] ?? ''}/${annotations['vcluster.loft.sh/object-name'] ?? ''}`;
      if (item.metadata?.name && item.metadata.labels?.['vcluster.loft.sh/namespace']) hostName.set(virtual, item.metadata.name);
    }
    const wanted = probes.filter((probe) => hostName.has(`${probe.namespace}/${probe.service}`));
    const missing = probes.filter((probe) => !hostName.has(`${probe.namespace}/${probe.service}`)).map((probe) => `${probe.namespace}/${probe.service}`);
    if (wanted.length) {
      await this.deps.apply(wanted.map((probe) => JSON.stringify(hostProbeManifest(place, probe, hostName.get(`${probe.namespace}/${probe.service}`)!))).join('\n---\n'));
    }
    const keep = new Set(wanted.map(probeResourceName));
    const existing = (await this.deps.kubectl(['get', 'probes.monitoring.coreos.com', '-n', place.hostNamespace, '-l', `${POOL_PROBE_LABEL}=true`, '-o', 'name']))
      .split('\n').map((line) => line.trim().split('/').pop() ?? '').filter(Boolean);
    const stale = existing.filter((resource) => !keep.has(resource));
    if (stale.length) await this.deps.kubectl(['delete', 'probes.monitoring.coreos.com', '-n', place.hostNamespace, '--ignore-not-found', ...stale]);
    return { probed: wanted.length, missing };
  }

  async setRule(place: PoolPlace, rule: PoolRule): Promise<void> {
    const manifest = hostRuleManifest(place, rule);
    if ('error' in manifest) throw new PoolMonitoringError(400, manifest.error as string);
    await this.deps.apply(JSON.stringify(manifest));
  }

  async removeRule(place: PoolPlace, id: string): Promise<void> {
    await this.deps.kubectl(['delete', 'prometheusrule', ruleResourceName(id), '-n', place.hostNamespace, '--ignore-not-found']);
  }
}
