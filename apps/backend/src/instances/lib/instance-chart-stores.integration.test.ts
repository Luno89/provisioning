import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { TOOLS } from '../../infrastructure/testing/real-k3s.js';
import { testNamespaces } from '../../infrastructure/testing/test-namespaces.js';

const REPO = resolve(import.meta.dirname, '../../../../..');
const CHART = resolve(REPO, 'charts/instance');
const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const STORES = namespaces.name('stores');
const ADOPT = namespaces.name('adopt');

afterAll(async () => { await namespaces.removeAll(); }, 0);

interface Doc { kind: string; metadata: { name: string; labels?: Record<string, string> }; data?: Record<string, string> }

describe('the instance chart\'s MinIO on a real cluster', () => {
  it('comes up ready on the shared volume, answers the instance\'s own pods only, and keeps its keys when the chart is rendered again', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'koala-chart-stores-'));
    const kubeconfig = join(folder, 'admin.yaml');
    writeFileSync(kubeconfig, k3s.admin, { mode: 0o600 });
    const namespace = STORES;
    const kubectl = (...args: string[]): string => execFileSync(TOOLS.kubectl, ['--kubeconfig', kubeconfig, '-n', namespace, ...args], { encoding: 'utf8' });
    const rendered = (): Doc[] => parseAllDocuments(execFileSync(TOOLS.helm, [
      'template', 'luno', CHART, '--namespace', namespace, '--kubeconfig', kubeconfig, '--dry-run=server',
      '--set', 'instance.id=i', '--set', 'instance.ownerId=o', '--set', 'instance.rootUrl=https://app.example.com', '--set', 'instance.rootPublicKeys=PEM', '--set', 'instance.credential=c', '--set', 'publicUrl=https://luno.example.com', '--set', 'storage.total=1Gi',
    ], { encoding: 'utf8' })).map((doc) => doc.toJSON() as Doc).filter((doc) => doc?.kind);
    const wanted = (docs: Doc[]) => docs.filter((doc) => (doc.kind === 'PersistentVolumeClaim' && doc.metadata.name === 'luno-data')
      || (doc.kind === 'Secret' && doc.metadata.name === 'luno-keys')
      || (['Service', 'StatefulSet'].includes(doc.kind) && doc.metadata.name === 'luno-minio')
      || (doc.kind === 'NetworkPolicy' && doc.metadata.name === 'luno-stores'));
    execFileSync(TOOLS.kubectl, ['--kubeconfig', kubeconfig, 'create', 'namespace', namespace]);
    const first = wanted(rendered());
    expect(first.map((doc) => `${doc.kind}/${doc.metadata.name}`).sort()).toEqual(['NetworkPolicy/luno-stores', 'PersistentVolumeClaim/luno-data', 'Secret/luno-keys', 'Service/luno-minio', 'StatefulSet/luno-minio']);
    const manifest = join(folder, 'stores.json');
    writeFileSync(manifest, JSON.stringify({ apiVersion: 'v1', kind: 'List', items: first }));
    kubectl('apply', '-f', manifest);
    kubectl('rollout', 'status', 'statefulset/luno-minio', '--timeout=720h');

    const knock = (name: string, labels: Record<string, string>, script: string): string => {
      kubectl('run', name, '--image=busybox:1.37', '--restart=Never', `--labels=${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(',')}`, '--command', '--', 'sh', '-c', script);
      kubectl('wait', `pod/${name}`, '--for=jsonpath={.status.phase}=Succeeded', '--timeout=720h');
      return kubectl('logs', name).trim().split('\n').at(-1)!;
    };
    const reaches = 'wget -q -T 5 -O /dev/null http://luno-minio:9000/minio/health/live 2>/dev/null';
    expect(knock('own', { 'app.kubernetes.io/part-of': 'nowrinkles-instance', 'app.kubernetes.io/instance': 'luno' }, `until ${reaches}; do sleep 1; done; echo reached`)).toBe('reached');
    expect(knock('stranger', { app: 'shop' }, `${reaches} && echo reached || echo refused`)).toBe('refused');

    const keysOf = (docs: Doc[]) => docs.find((doc) => doc.kind === 'Secret' && doc.metadata.name === 'luno-keys')!.data!;
    const again = keysOf(rendered());
    expect(again.MINIO_ROOT_USER).toBe(keysOf(first).MINIO_ROOT_USER);
    expect(again.MINIO_ROOT_PASSWORD).toBe(keysOf(first).MINIO_ROOT_PASSWORD);
    const volume = rendered().find((doc) => doc.kind === 'PersistentVolumeClaim') as Doc & { spec: { resources: { requests: { storage: string } } } };
    expect(volume.spec.resources.requests.storage).toBe('1Gi');
  }, 600_000);

  it('renders the one-time hook that brings an older instance\'s Mongo and Postgres onto the shared volume only while their old StatefulSets are there', () => {
    const folder = mkdtempSync(join(tmpdir(), 'koala-chart-adopt-'));
    const kubeconfig = join(folder, 'admin.yaml');
    writeFileSync(kubeconfig, k3s.admin, { mode: 0o600 });
    const namespace = ADOPT;
    const kubectl = (...args: string[]): string => execFileSync(TOOLS.kubectl, ['--kubeconfig', kubeconfig, '-n', namespace, ...args], { encoding: 'utf8' });
    const hook = () => parseAllDocuments(execFileSync(TOOLS.helm, [
      'template', 'luno', CHART, '--namespace', namespace, '--kubeconfig', kubeconfig, '--dry-run=server',
      '--set', 'instance.id=i', '--set', 'instance.ownerId=o', '--set', 'instance.rootUrl=https://app.example.com', '--set', 'instance.rootPublicKeys=PEM', '--set', 'instance.credential=c', '--set', 'publicUrl=https://luno.example.com', '--set', 'storage.total=1Gi',
    ], { encoding: 'utf8' })).map((doc) => doc.toJSON() as Doc & { spec?: { template: { spec: { volumes: unknown[]; containers: Array<{ args: string[] }> } } } })
      .find((doc) => doc?.kind === 'Job' && doc.metadata.name === 'luno-adopt-stores');
    execFileSync(TOOLS.kubectl, ['--kubeconfig', kubeconfig, 'create', 'namespace', namespace]);
    expect(hook()).toBeUndefined();
    const old = (name: string) => ({ apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name, namespace }, spec: { serviceName: name, replicas: 0, selector: { matchLabels: { old: name } }, template: { metadata: { labels: { old: name } }, spec: { containers: [{ name: 'x', image: 'busybox:1.37' }] } } } });
    const manifest = join(folder, 'old.json');
    writeFileSync(manifest, JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [old('luno-mongo'), old('luno-temporal-db')] }));
    kubectl('apply', '-f', manifest);
    const job = hook();
    expect(job?.spec?.template.spec.volumes).toEqual([
      { name: 'stores', persistentVolumeClaim: { claimName: 'luno-data' } },
      { name: 'old-mongo', persistentVolumeClaim: { claimName: 'data-luno-mongo-0' } },
      { name: 'old-temporal-db', persistentVolumeClaim: { claimName: 'data-luno-temporal-db-0' } },
    ]);
    const script = job!.spec!.template.spec.containers[0]!.args[0]!;
    expect(script).toContain('adopt luno-mongo /old/mongo mongo');
    expect(script).toContain('adopt luno-temporal-db /old/temporal-db temporal-db');
  }, 600_000);
});
