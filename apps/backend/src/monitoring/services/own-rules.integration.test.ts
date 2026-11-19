import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptValue, K3S_TRAEFIK_CONFIG, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ClusterAccess, runnersByRecord } from '../../infrastructure/index.js';
import { startK3s, TOOLS, type RealK3s } from '../../infrastructure/testing/real-k3s.js';
import { chartFolder, chartSourcesStandIn, type ChartSourcesStandIn } from '../../infrastructure/testing/chart-sources-stand-in.js';
import { PROMETHEUS_CHART, PROMETHEUS_CHART_REPO } from '../lib/monitoring-history.js';
import type { PoolProbe } from '../lib/pool-monitoring.js';
import { INSTANCE_ALERTS } from '../lib/root-alerts.js';
import { MonitoringService, prometheusAt, type PoolMonitor } from './MonitoringService.js';
import { AlertWatchService } from './AlertWatchService.js';
import { prometheusStandIn, type PrometheusStandIn } from '../testing/prometheus-stand-in.js';

let k3s: RealK3s;
let sources: ChartSourcesStandIn;
const KEY = 'own-rules-key' as never;
const RULE_TYPE = readFileSync(join(import.meta.dirname, '../testing/prometheusrules-crd-operator-0.93.1.json'), 'utf8');
const STACK_VERSION = '0.1.0';

const crdOf = (plural: string, kind: string): string => `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: {name: ${plural}.monitoring.coreos.com}
spec:
  group: monitoring.coreos.com
  names: {kind: ${kind}, plural: ${plural}, singular: ${kind.toLowerCase()}, listKind: ${kind}List}
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema: {openAPIV3Schema: {type: object, x-kubernetes-preserve-unknown-fields: true}}
`;

beforeAll(async () => {
  sources = await chartSourcesStandIn();
  sources.publish(chartFolder({
    'Chart.yaml': `apiVersion: v2\nname: ${PROMETHEUS_CHART}\nversion: ${STACK_VERSION}\n`,
    'values.yaml': 'prometheus:\n  prometheusSpec:\n    enableRemoteWriteReceiver: false\n',
    'crds/prometheuses.yaml': crdOf('prometheuses', 'Prometheus'),
    'templates/prometheus.yaml': 'apiVersion: monitoring.coreos.com/v1\nkind: Prometheus\nmetadata: {name: kube-prometheus-stack-prometheus}\nspec:\n  enableRemoteWriteReceiver: {{ .Values.prometheus.prometheusSpec.enableRemoteWriteReceiver }}\n',
  }), PROMETHEUS_CHART_REPO);
  k3s = await startK3s();
}, 0);
afterAll(async () => {
  await sources?.close();
  await k3s?.stop();
}, 0);

interface Watched { access: ClusterAccess; home: ClusterMetadata; watch: AlertWatchService; said: string[]; prom: PrometheusStandIn }

async function watched(id: string, given: { instanceAlerts?: boolean; pool?: PoolMonitor } = {}): Promise<Watched> {
  const db = await testDatabase();
  const home = { id, name: id, provider: 'machine', machineId: id, status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata;
  await db.infrastructure.saveCluster(home);
  const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'elsewhere', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-own-rules-watch-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY, chartSources: sources.url });
  const prom = await prometheusStandIn();
  prom.set('vector(1)', 1);
  const monitoring = new MonitoringService({
    store: db,
    ownCluster: async () => home,
    ownClusterId: () => home.id,
    prometheus: async () => prom.client,
    pool: () => given.pool,
    ...runnersByRecord(access),
    instanceAlerts: given.instanceAlerts,
  });
  const said: string[] = [];
  const watch = new AlertWatchService({ monitoring, store: db, people: async () => [], tell: async () => undefined, log: (line) => said.push(line) });
  return { access, home, watch, said, prom };
}

describe('the alerts a Koala sets on the cluster it runs in, applied to a real cluster', () => {
  it('on an instance, writes its workers\' rules into that cluster\'s monitoring namespace, rule by rule', async () => {
    const db = await testDatabase();
    const home = { id: 'machine-home', name: 'home', provider: 'machine', machineId: 'home', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata;
    await db.infrastructure.saveCluster(home);
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'elsewhere', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-own-rules-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
    await access.apply(home.id, RULE_TYPE);
    await access.kubectl(home.id, ['wait', '--for=condition=Established', 'crd/prometheusrules.monitoring.coreos.com', '--timeout=720h']);
    await access.kubectl(home.id, ['create', 'namespace', 'monitoring', '--dry-run=client', '-o', 'yaml']).then((namespace) => access.apply(home.id, namespace));

    const monitoring = new MonitoringService({
      store: db,
      ownCluster: async () => home,
      ownClusterId: () => home.id,
      prometheus: async () => prometheusAt('http://127.0.0.1:1'),
      ...runnersByRecord(access),
      instanceAlerts: true,
    });
    await monitoring.applyOwnRules(home);

    const written = JSON.parse(await access.kubectl(home.id, ['get', 'prometheusrule', 'koala-instance-alerts', '-n', 'monitoring', '-o', 'json'])) as { spec: { groups: { rules: { expr: string; labels: Record<string, string> }[] }[] } };
    expect(written.spec.groups[0]!.rules.map((rule) => [rule.labels.koala_rule, rule.expr])).toEqual(INSTANCE_ALERTS.map((alert) => [alert.id, alert.expr]));
  });

  it('on an instance, are written by the alert watcher\'s own pass, which carries on past what the cluster lacks', async () => {
    const { access, home, watch, said, prom } = await watched('machine-watched', { instanceAlerts: true });
    await access.apply(home.id, RULE_TYPE);
    await access.kubectl(home.id, ['wait', '--for=condition=Established', 'crd/prometheusrules.monitoring.coreos.com', '--timeout=720h']);
    await access.kubectl(home.id, ['create', 'namespace', 'monitoring', '--dry-run=client', '-o', 'yaml']).then((namespace) => access.apply(home.id, namespace));
    await access.kubectl(home.id, ['delete', 'prometheusrule', 'koala-instance-alerts', '-n', 'monitoring', '--ignore-not-found']);

    await watch.tick();
    await prom.close();

    const written = JSON.parse(await access.kubectl(home.id, ['get', 'prometheusrule', 'koala-instance-alerts', '-n', 'monitoring', '-o', 'json'])) as { spec: { groups: { rules: { labels: Record<string, string> }[] }[] } };
    expect(written.spec.groups[0]!.rules.map((rule) => rule.labels.koala_rule)).toEqual(INSTANCE_ALERTS.map((alert) => alert.id));
    expect(said.some((line) => line.includes('alerts could not be set'))).toBe(false);
  });
});

describe('the alert watcher\'s pass over the cluster Koala runs in', () => {
  it('sets its Prometheus to take what the machines send and has k3s\'s Traefik count each app\'s requests', async () => {
    const { access, home, watch, said, prom } = await watched('machine-home');
    await access.helm(home.id, ['upgrade', '--install', PROMETHEUS_CHART, PROMETHEUS_CHART, '--repo', PROMETHEUS_CHART_REPO, '--version', STACK_VERSION, '-n', 'monitoring', '--create-namespace']);
    await access.helm(home.id, ['install', 'traefik', chartFolder({
      'Chart.yaml': 'apiVersion: v2\nname: traefik\nversion: 0.1.0\n',
      'templates/note.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: traefik-note}\ndata: {said: hello}\n',
    }), '-n', 'kube-system']);
    const receives = async () => (await access.kubectl(home.id, ['get', 'prometheus', 'kube-prometheus-stack-prometheus', '-n', 'monitoring', '-o', 'jsonpath={.spec.enableRemoteWriteReceiver}'])).trim();
    expect(await receives()).toBe('false');

    await watch.tick();
    await prom.close();

    expect(await receives()).toBe('true');
    expect(said).toContain('[alerts] machine-home now takes the metrics its machines send');
    const counting = JSON.parse(await access.kubectl(home.id, ['get', 'helmchartconfig', 'traefik', '-n', 'kube-system', '-o', 'json'])) as { spec: { valuesContent: string } };
    expect(counting.spec.valuesContent).toBe(K3S_TRAEFIK_CONFIG.spec.valuesContent);
    expect(said).toContain('[alerts] machine-home now counts each app\'s requests');
  });
});

describe('the alert watcher\'s pass over Koala\'s servers', () => {
  it('hands the probes the apps there declare to the pool\'s monitoring', async () => {
    const handed: PoolProbe[][] = [];
    const pool: PoolMonitor = {
      ask: async () => [],
      askRange: async () => [],
      alerts: async () => [],
      history: async () => ({ days: 15 }),
      setRule: async () => undefined,
      removeRule: async () => undefined,
      setProbes: async (probes) => { handed.push(probes); },
    };
    const { access, home, watch, prom } = await watched('machine-pool', { pool });
    await access.apply(home.id, crdOf('probes', 'Probe'));
    await access.kubectl(home.id, ['wait', '--for=condition=Established', 'crd/probes.monitoring.coreos.com', '--timeout=720h']);
    await access.kubectl(home.id, ['create', 'namespace', 'shop']);
    await access.apply(home.id, JSON.stringify({ apiVersion: 'monitoring.coreos.com/v1', kind: 'Probe', metadata: { name: 'web', namespace: 'shop' }, spec: { module: 'http_2xx', targets: { staticConfig: { static: ['web.shop.svc.cluster.local:80/health'] } } } }));

    await watch.tick();
    await prom.close();

    expect(handed).toEqual([[{ namespace: 'shop', service: 'web', port: 80, path: '/health', module: 'http_2xx' }]]);
  });
});
