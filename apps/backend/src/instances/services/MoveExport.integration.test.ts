import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { ClusterAccess, startedMachine } from '../../infrastructure/index.js';
import { TOOLS } from '../../infrastructure/testing/real-k3s.js';
import { trustedKeys } from '../lib/identity-token.js';
import { REPLICAS_ANNOTATION } from '../lib/app-move.js';
import { MoveExport, moveClusterOn, SELF_UPGRADE } from './MoveExport.js';

const k3s = inject('k3s');

const crd = (plural: string, group: string, kind: string): string =>
  `apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: ${plural}.${group}\nspec:\n  group: ${group}\n  scope: Namespaced\n  names:\n    plural: ${plural}\n    kind: ${kind}\n  versions:\n    - name: v1\n      served: true\n      storage: true\n      schema:\n        openAPIV3Schema:\n          type: object\n          x-kubernetes-preserve-unknown-fields: true\n`;

const appCrds = [
  crd('ingressroutes', 'traefik.io', 'IngressRoute'),
  crd('middlewares', 'traefik.io', 'Middleware'),
  crd('probes', 'monitoring.coreos.com', 'Probe'),
  crd('servicemonitors', 'monitoring.coreos.com', 'ServiceMonitor'),
  crd('podmonitors', 'monitoring.coreos.com', 'PodMonitor'),
  crd('prometheusrules', 'monitoring.coreos.com', 'PrometheusRule'),
].join('---\n');

const manifests = [
  `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${SELF_UPGRADE.namespace}\n`,
  `apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: ${SELF_UPGRADE.name}\n  namespace: ${SELF_UPGRADE.namespace}\nspec:\n  schedule: "0 * * * *"\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: Never\n          containers:\n            - name: c\n              image: registry.invalid/none:1\n`,
  'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shelf\n  labels:\n    team: a\n',
  'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: shelf\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      terminationGracePeriodSeconds: 0\n      containers:\n        - name: c\n          image: registry.invalid/none:1\n',
  'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config\n  namespace: shelf\ndata:\n  a: b\n',
].join('---\n');

describe('a pool instance stopping for a move and taking work again, on a real cluster', () => {
  it('pauses its self-upgrade, scales its apps to nothing remembering how many ran, and starts them again as they were', async () => {
    const access = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-move-export-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS });
    const own = startedMachine('machine-pool', k3s.admin);
    await access.apply(own, appCrds);
    await access.kubectl(own, ['wait', '--for=condition=Established', 'crd/ingressroutes.traefik.io', 'crd/middlewares.traefik.io', 'crd/probes.monitoring.coreos.com', 'crd/servicemonitors.monitoring.coreos.com', 'crd/podmonitors.monitoring.coreos.com', 'crd/prometheusrules.monitoring.coreos.com']);
    await access.apply(own, manifests);
    const move = new MoveExport({
      instanceId: 'inst-bo',
      trusted: trustedKeys([]),
      dataDir: mkdtempSync(join(tmpdir(), 'koala-move-data-')),
      mongo: { uri: 'mongodb://unused', dbName: 'unused' },
      env: {},
      running: async () => [],
      claim: async () => true,
      cluster: moveClusterOn({
        kubectl: (target, args) => access.kubectl(target, args),
        own: () => own,
        start: async () => { throw new Error('this test reads no part'); },
      }),
    });
    const kubectl = (...args: string[]) => access.kubectl(own, args);

    expect(await move.freeze()).toBeUndefined();
    expect(await kubectl('get', 'cronjob', SELF_UPGRADE.name, '-n', SELF_UPGRADE.namespace, '-o', 'jsonpath={.spec.suspend}')).toBe('true');

    const apps = await move.apps('reg.test');
    const shelf = apps.namespaces.find((entry) => entry.namespace === 'shelf');
    expect(shelf?.labels).toEqual({ team: 'a', 'kubernetes.io/metadata.name': 'shelf' });
    expect(shelf?.objects.map((object) => object.metadata?.name)).toContain('web-config');
    expect(await kubectl('get', 'deployment', 'web', '-n', 'shelf', '-o', 'jsonpath={.spec.replicas}')).toBe('0');
    expect(await kubectl('get', 'deployment', 'web', '-n', 'shelf', '-o', `jsonpath={.metadata.annotations.${REPLICAS_ANNOTATION.replace(/\./g, '\\.')}}`)).toBe('1');

    expect(await move.thaw()).toEqual([]);
    expect(await kubectl('get', 'deployment', 'web', '-n', 'shelf', '-o', 'jsonpath={.spec.replicas}')).toBe('1');
    expect(await kubectl('get', 'deployment', 'web', '-n', 'shelf', '-o', 'jsonpath={.metadata.annotations}')).not.toContain(REPLICAS_ANNOTATION);
    expect(await kubectl('get', 'cronjob', SELF_UPGRADE.name, '-n', SELF_UPGRADE.namespace, '-o', 'jsonpath={.spec.suspend}')).toBe('false');
  }, 120_000);
});
