import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptValue, K3S_TRAEFIK_CONFIG, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ClusterAccess, runnersByRecord } from '../../infrastructure/index.js';
import { startK3s, TOOLS, type RealK3s } from '../../infrastructure/testing/real-k3s.js';
import { PROMETHEUS_CHART, PROMETHEUS_CHART_REPO } from '../lib/monitoring-history.js';
import type { PoolProbe } from '../lib/pool-monitoring.js';
import { MonitoringService, type PoolMonitor } from './MonitoringService.js';
import { AlertWatchService } from './AlertWatchService.js';
import { prometheusStandIn, type PrometheusStandIn } from '../testing/prometheus-stand-in.js';

const KEY = 'alert-watch-cluster-key' as never;
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

const PROMETHEUS = `apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata: {name: kube-prometheus-stack-prometheus}
spec:
  enableRemoteWriteReceiver: {{ .Values.prometheus.prometheusSpec.enableRemoteWriteReceiver }}
  {{- with .Values.prometheus.prometheusSpec.retention }}
  retention: {{ . }}
  {{- end }}
`;

let k3s: RealK3s;
let server: Server;
let sources = '';
const served = mkdtempSync(join(tmpdir(), 'koala-watch-chart-sources-'));

function chartDir(name: string, files: Record<string, string>): string {
  const chart = mkdtempSync(join(tmpdir(), `koala-watch-${name}-`));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(chart, file, '..'), { recursive: true });
    writeFileSync(join(chart, file), content);
  }
  return chart;
}

beforeAll(async () => {
  const repoDir = join(served, PROMETHEUS_CHART_REPO.replace(/^https:\/\//, ''));
  mkdirSync(repoDir, { recursive: true });
  server = createServer((req, res) => {
    readFile(join(served, decodeURIComponent((req.url ?? '/').slice(1)))).then((body) => res.end(body), () => { res.statusCode = 404; res.end(); });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  sources = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stack = chartDir('stack', {
    'Chart.yaml': `apiVersion: v2\nname: ${PROMETHEUS_CHART}\nversion: ${STACK_VERSION}\n`,
    'values.yaml': 'prometheus:\n  prometheusSpec:\n    enableRemoteWriteReceiver: false\n',
    'crds/prometheuses.yaml': crdOf('prometheuses', 'Prometheus'),
    'templates/prometheus.yaml': PROMETHEUS,
  });
  execFileSync(TOOLS.helm, ['package', stack, '--destination', repoDir]);
  execFileSync(TOOLS.helm, ['repo', 'index', repoDir, '--url', `${sources}/${PROMETHEUS_CHART_REPO.replace(/^https:\/\//, '')}`]);
  k3s = await startK3s();
}, 0);

afterAll(async () => {
  await new Promise((closed) => server?.close(closed));
  await k3s?.stop();
}, 0);

async function watched(id: string, pool?: PoolMonitor): Promise<{ access: ClusterAccess; home: ClusterMetadata; watch: AlertWatchService; said: string[]; prom: PrometheusStandIn }> {
  const db = await testDatabase();
  const home = { id, name: id, provider: 'machine', machineId: id, status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata;
  await db.infrastructure.saveCluster(home);
  const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'elsewhere', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-watch-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY, chartSources: sources });
  const prom = await prometheusStandIn();
  prom.set('vector(1)', 1);
  const monitoring = new MonitoringService({
    store: db,
    ownCluster: async () => home,
    ownClusterId: () => home.id,
    prometheus: async () => prom.client,
    pool: () => pool,
    ...runnersByRecord(access),
  });
  const said: string[] = [];
  const watch = new AlertWatchService({ monitoring, store: db, people: async () => [], tell: async () => undefined, log: (line) => said.push(line) });
  return { access, home, watch, said, prom };
}

describe('the alert watcher\'s pass over the cluster Koala runs in', () => {
  it('sets its Prometheus to take what the machines send and has k3s\'s Traefik count each app\'s requests', async () => {
    const { access, home, watch, said, prom } = await watched('machine-home');
    await access.helm(home.id, ['install', PROMETHEUS_CHART, PROMETHEUS_CHART, '--repo', PROMETHEUS_CHART_REPO, '--version', STACK_VERSION, '-n', 'monitoring', '--create-namespace']);
    await access.helm(home.id, ['install', 'traefik', chartDir('traefik', {
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
    const { access, home, watch, prom } = await watched('machine-pool', pool);
    await access.apply(home.id, crdOf('probes', 'Probe'));
    await access.kubectl(home.id, ['wait', '--for=condition=Established', 'crd/probes.monitoring.coreos.com', '--timeout=720h']);
    await access.kubectl(home.id, ['create', 'namespace', 'shop']);
    await access.apply(home.id, JSON.stringify({ apiVersion: 'monitoring.coreos.com/v1', kind: 'Probe', metadata: { name: 'web', namespace: 'shop' }, spec: { module: 'http_2xx', targets: { staticConfig: { static: ['web.shop.svc.cluster.local:80/health'] } } } }));

    await watch.tick();
    await prom.close();

    expect(handed).toEqual([[{ namespace: 'shop', service: 'web', port: 80, path: '/health', module: 'http_2xx' }]]);
  });
});
