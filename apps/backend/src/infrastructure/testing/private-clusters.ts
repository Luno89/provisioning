import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { waitUntil } from '@koala/provision';
import { installVcluster, vclusterSecret } from '../../activities/vcluster.js';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { startedMachine, type ServiceAccount } from '../lib/cluster-places.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from '../services/ClusterAccess.js';
import { removeNamespaces } from './test-namespaces.js';

declare module 'vitest' {
  export interface ProvidedContext {
    privateClusters: { folder: string; files: string[] };
  }
}

export const PRIVATE_CLUSTER_FILES = [
  'src/activities/chart-crds.integration.test.ts',
  'src/activities/cluster-monitoring.integration.test.ts',
  'src/activities/cluster-steps.integration.test.ts',
  'src/activities/platform-provision.integration.test.ts',
  'src/activities/ProvisionPieceActivity.integration.test.ts',
  'src/infrastructure/services/AppExposureService.integration.test.ts',
  'src/infrastructure/services/EgressService.integration.test.ts',
  'src/infrastructure/testing/cluster-wide.integration.test.ts',
  'src/infrastructure/testing/private-cluster.integration.test.ts',
  'src/infrastructure/wiring/provisioning-to-root.integration.test.ts',
  'src/instances/services/MoveExport.integration.test.ts',
  'src/monitoring/services/own-rules.integration.test.ts',
  'src/workflows/model-ready.integration.test.ts',
];

export const TEST_CHARTS = join(homedir(), '.cache', 'koala', 'charts');

export interface SharedK3s {
  admin: string;
  account: ServiceAccount;
}

export interface PrivateCluster {
  namespace: string;
  address: string;
  admin: string;
  account: ServiceAccount;
  folder: string;
  stop(): Promise<void>;
}

interface Started {
  namespace: string;
  address: string;
  admin: string;
}

const RELEASE = 'cluster';
const K3S_OWN = ['runtimeclass/nvidia', 'crd/helmcharts.helm.cattle.io', 'crd/helmchartconfigs.helm.cattle.io'];
const NAMESPACE_ROOM = 63 - 'vc-'.length - '-12345678'.length;

const slugOf = (file: string): string => basename(file).replace(/\.(integration\.)?test\.ts$/, '').replace(/\.ts$/, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').slice(0, NAMESPACE_ROOM).replace(/^-+|-+$/g, '');

const markerOf = (file: string): string => file.replace(/[^A-Za-z0-9.]+/g, '_');

export function privateClusterFileOf(file: string): string {
  const found = PRIVATE_CLUSTER_FILES.find((entry) => file === entry || file.endsWith(`/${entry}`));
  if (!found) throw new Error(`${file} asks for a cluster of its own but is not in PRIVATE_CLUSTER_FILES, so the run started none for it: add it there`);
  return found;
}

const valuesOn = (nodeAddress: string): Record<string, unknown> => ({
  controlPlane: {
    service: { spec: { type: 'NodePort' } },
    proxy: { extraSANs: [nodeAddress] },
    statefulSet: { persistence: { volumeClaim: { enabled: false } } },
  },
  rbac: { enableVolumeSnapshotRules: { enabled: false } },
});

const accessOn = async (shared: SharedK3s): Promise<ClusterAccess> => new ClusterAccess({
  here: { koalaMachineId: 'test-run', root: false }, folder: await mkdtemp(join(tmpdir(), 'koala-private-cluster-')),
  processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: shared.account,
});

export async function controlPlaneGone(access: Pick<ClusterAccess, 'kubectl' | 'own'>, namespace: string): Promise<string | undefined> {
  const left = await access.kubectl(access.own(), ['get', 'deployment', RELEASE, '-n', namespace, '--ignore-not-found', '-o', 'name']);
  return left.trim() ? undefined : 'its control plane is gone';
}

async function startPrivateCluster(shared: SharedK3s, file: string, charts: string, named: (namespace: string) => void): Promise<Started> {
  const access = await accessOn(shared);
  const host = access.own();
  const namespace = `vc-${slugOf(file)}-${randomUUID().slice(0, 8)}`;
  named(namespace);
  await access.kubectl(host, ['create', 'namespace', namespace]);
  const address = (await access.kubectl(host, ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'])).trim();
  await installVcluster(access, host, charts, { name: RELEASE, namespace, values: valuesOn(address) }, (ms) => new Promise((done) => { setTimeout(done, ms); }));
  const port = (await access.kubectl(host, ['get', 'service', RELEASE, '-n', namespace, '-o', 'jsonpath={.spec.ports[?(@.name=="https")].nodePort}'])).trim();
  const signIn = Buffer.from(await access.kubectl(host, ['get', 'secret', vclusterSecret(RELEASE), '-n', namespace, '-o', 'jsonpath={.data.config}']), 'base64').toString('utf8');
  const admin = signIn.replace(/server: \S+/, `server: https://${address}:${port}`);
  const inside = startedMachine(`private-${namespace}`, admin);
  await waitUntil(`the vcluster in ${namespace} to answer at ${address}:${port}`, async () => { await access.kubectl(inside, ['get', '--raw', '/readyz']); return true; }, () => controlPlaneGone(access, namespace));
  await access.kubectl(inside, ['wait', '--for=create', 'serviceaccount/default', '-n', 'default', '--timeout=720h']);
  await access.kubectl(inside, ['wait', '--for=create', 'deployment/coredns', '-n', 'kube-system', '--timeout=720h']);
  await access.kubectl(inside, ['wait', '--for=condition=Available', 'deployment/coredns', '-n', 'kube-system', '--timeout=720h']);
  const k3sOwn = JSON.parse(await access.kubectl(host, ['get', ...K3S_OWN, '-o', 'json'])) as { items: { apiVersion: string; kind: string; metadata: { name: string; labels?: Record<string, string> }; status?: unknown }[] };
  await access.apply(inside, k3sOwn.items.map(({ apiVersion, kind, metadata, status: _status, ...rest }) => JSON.stringify({ apiVersion, kind, metadata: { name: metadata.name, labels: metadata.labels ?? {} }, ...rest })).join('\n---\n'));
  await access.kubectl(inside, ['wait', '--for=condition=Established', ...K3S_OWN.filter((name) => name.startsWith('crd/')), '--timeout=720h']);
  await access.kubectl(inside, ['create', 'serviceaccount', 'koala', '-n', 'default']);
  await access.kubectl(inside, ['create', 'clusterrolebinding', 'koala', '--clusterrole=cluster-admin', '--serviceaccount=default:koala']);
  return { namespace, address, admin };
}

export interface PrivateClusters {
  removeUntaken(): Promise<void>;
}

export async function startPrivateClusters(shared: SharedK3s, files: readonly string[], folder: string, charts: string): Promise<PrivateClusters> {
  await mkdir(folder, { recursive: true });
  const namespaces = new Map<string, string>();
  const starting = files.map(async (file) => {
    const marker = join(folder, markerOf(file));
    try {
      const started = await startPrivateCluster(shared, file, charts, (namespace) => namespaces.set(file, namespace));
      await writeFile(`${marker}.landing`, JSON.stringify(started), { mode: 0o600 });
      await rename(`${marker}.landing`, `${marker}.ready`);
    } catch (failure) {
      await writeFile(`${marker}.landing`, failure instanceof Error ? failure.stack ?? failure.message : String(failure));
      await rename(`${marker}.landing`, `${marker}.failed`);
    }
  });
  return {
    async removeUntaken() {
      await Promise.all(starting);
      const untaken: string[] = [];
      for (const file of files) {
        const namespace = namespaces.get(file);
        if (!namespace) continue;
        const marker = join(folder, markerOf(file));
        const taken = await readFile(`${marker}.taken`).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; });
        if (!taken) untaken.push(namespace);
      }
      await removeNamespaces(shared.admin, untaken);
    },
  };
}

function landed(folder: string, marker: string): Promise<{ ready: string } | { failed: string }> {
  return new Promise((done, failed) => {
    let settled = false;
    const look = async (): Promise<void> => {
      const ready = await readFile(join(folder, `${marker}.ready`), 'utf8').catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return undefined; throw err; });
      if (ready !== undefined) return finish({ ready });
      const why = await readFile(join(folder, `${marker}.failed`), 'utf8').catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return undefined; throw err; });
      if (why !== undefined) finish({ failed: why });
    };
    const watcher = watch(folder, (_event, name) => { if (name?.startsWith(marker)) look().catch(stop); });
    const finish = (found: { ready: string } | { failed: string }) => {
      if (settled) return;
      settled = true;
      watcher.close();
      done(found);
    };
    const stop = (err: unknown) => {
      if (settled) return;
      settled = true;
      watcher.close();
      failed(err);
    };
    watcher.on('error', stop);
    look().catch(stop);
  });
}

export async function takePrivateCluster(shared: SharedK3s, folder: string, file: string): Promise<PrivateCluster> {
  const marker = markerOf(file);
  const found = await landed(folder, marker);
  if ('failed' in found) throw new Error(`the cluster started for ${file} at the run's start did not come up: ${found.failed}`);
  await rename(join(folder, `${marker}.ready`), join(folder, `${marker}.taken`));
  const started = JSON.parse(found.ready) as Started;
  const access = await accessOn(shared);
  const own = await mkdtemp(join(tmpdir(), 'koala-private-cluster-own-'));
  const inside = startedMachine(`private-${started.namespace}`, started.admin);
  const token = (await access.kubectl(inside, ['create', 'token', 'koala', '-n', 'default', '--duration=1h'])).trim();
  const [, port] = /server: https:\/\/[^:]+:(\d+)/.exec(started.admin)!;
  const account: ServiceAccount = { host: started.address, port: port!, caFile: join(own, 'ca.crt'), tokenFile: join(own, 'token') };
  await writeFile(join(own, 'admin.yaml'), started.admin, { mode: 0o600 });
  await writeFile(account.caFile, Buffer.from(/certificate-authority-data: (\S+)/.exec(started.admin)![1]!, 'base64').toString('utf8'), { mode: 0o600 });
  await writeFile(account.tokenFile, token, { mode: 0o600 });
  return { namespace: started.namespace, address: started.address, admin: started.admin, account, folder: own, stop: () => removeNamespaces(shared.admin, [started.namespace]) };
}
