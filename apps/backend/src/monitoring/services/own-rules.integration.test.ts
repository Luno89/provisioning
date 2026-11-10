import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ClusterAccess, runnersByRecord } from '../../infrastructure/index.js';
import { TOOLS } from '../../infrastructure/testing/real-k3s.js';
import { INSTANCE_ALERTS } from '../lib/root-alerts.js';
import { MonitoringService, prometheusAt } from './MonitoringService.js';
import { AlertWatchService } from './AlertWatchService.js';
import { prometheusStandIn } from '../testing/prometheus-stand-in.js';

const k3s = inject('k3s');
const KEY = 'own-rules-key' as never;
const RULE_TYPE = readFileSync(join(import.meta.dirname, '../testing/prometheusrules-crd-operator-0.93.1.json'), 'utf8');

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
  }, 300_000);

  it('on an instance, are written by the alert watcher\'s own pass, which carries on past what the cluster lacks', async () => {
    const db = await testDatabase();
    const home = { id: 'machine-watched', name: 'watched', provider: 'machine', machineId: 'watched', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata;
    await db.infrastructure.saveCluster(home);
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'elsewhere', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-own-rules-watch-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
    await access.apply(home.id, RULE_TYPE);
    await access.kubectl(home.id, ['wait', '--for=condition=Established', 'crd/prometheusrules.monitoring.coreos.com', '--timeout=720h']);
    await access.kubectl(home.id, ['create', 'namespace', 'monitoring', '--dry-run=client', '-o', 'yaml']).then((namespace) => access.apply(home.id, namespace));
    await access.kubectl(home.id, ['delete', 'prometheusrule', 'koala-instance-alerts', '-n', 'monitoring', '--ignore-not-found']);
    const prom = await prometheusStandIn();
    prom.set('vector(1)', 1);
    const monitoring = new MonitoringService({
      store: db,
      ownCluster: async () => home,
      ownClusterId: () => home.id,
      prometheus: async () => prom.client,
      ...runnersByRecord(access),
      instanceAlerts: true,
    });
    const said: string[] = [];
    const watch = new AlertWatchService({ monitoring, store: db, people: async () => [], tell: async () => undefined, log: (line) => said.push(line) });
    await watch.tick();
    await prom.close();

    const written = JSON.parse(await access.kubectl(home.id, ['get', 'prometheusrule', 'koala-instance-alerts', '-n', 'monitoring', '-o', 'json'])) as { spec: { groups: { rules: { labels: Record<string, string> }[] }[] } };
    expect(written.spec.groups[0]!.rules.map((rule) => rule.labels.koala_rule)).toEqual(INSTANCE_ALERTS.map((alert) => alert.id));
    expect(said.some((line) => line.includes('alerts could not be set'))).toBe(false);
  }, 300_000);
});
