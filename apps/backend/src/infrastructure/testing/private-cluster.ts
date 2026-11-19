import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { inject } from 'vitest';
import { installVcluster, vclusterSecret } from '../../activities/vcluster.js';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { startedMachine, type ServiceAccount } from '../lib/cluster-places.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from '../services/ClusterAccess.js';
import { testNamespaces } from './test-namespaces.js';

export interface PrivateCluster {
  namespace: string;
  admin: string;
  account: ServiceAccount;
  folder: string;
  stop(): Promise<void>;
}

const RELEASE = 'cluster';
const NAMESPACE_ROOM = 63 - 'vc-'.length - '-12345678'.length;

const slugOf = (file: string): string => basename(file).replace(/\.(integration\.)?test\.ts$/, '').replace(/\.ts$/, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').slice(0, NAMESPACE_ROOM).replace(/^-+|-+$/g, '');

const valuesOn = (nodeAddress: string): Record<string, unknown> => ({
  controlPlane: {
    service: { spec: { type: 'NodePort' } },
    proxy: { extraSANs: [nodeAddress] },
    statefulSet: { persistence: { volumeClaim: { enabled: false } } },
  },
  rbac: { enableVolumeSnapshotRules: { enabled: false } },
});

export async function privateCluster(file: string): Promise<PrivateCluster> {
  const shared = inject('k3s');
  const folder = mkdtempSync(join(tmpdir(), 'koala-private-cluster-'));
  const access = new ClusterAccess({ here: { koalaMachineId: 'test-run', root: false }, folder, processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: shared.account });
  const host = access.own();
  const namespaces = testNamespaces(shared.admin);
  const namespace = namespaces.name(`vc-${slugOf(file)}`);
  try {
    await access.kubectl(host, ['create', 'namespace', namespace]);
    const nodeAddress = (await access.kubectl(host, ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'])).trim();
    await installVcluster(access, host, { name: RELEASE, namespace, values: valuesOn(nodeAddress) }, (ms) => new Promise((done) => { setTimeout(done, ms); }));
    const nodePort = (await access.kubectl(host, ['get', 'service', RELEASE, '-n', namespace, '-o', 'jsonpath={.spec.ports[?(@.name=="https")].nodePort}'])).trim();
    const signIn = Buffer.from(await access.kubectl(host, ['get', 'secret', vclusterSecret(RELEASE), '-n', namespace, '-o', 'jsonpath={.data.config}']), 'base64').toString('utf8');
    const admin = signIn.replace(/server: \S+/, `server: https://${nodeAddress}:${nodePort}`);
    writeFileSync(join(folder, 'admin.yaml'), admin, { mode: 0o600 });
    const inside = startedMachine(`private-${namespace}`, admin);
    await access.kubectl(inside, ['wait', '--for=create', 'serviceaccount/default', '-n', 'default', '--timeout=720h']);
    await access.kubectl(inside, ['wait', '--for=create', 'deployment/coredns', '-n', 'kube-system', '--timeout=720h']);
    await access.kubectl(inside, ['wait', '--for=condition=Available', 'deployment/coredns', '-n', 'kube-system', '--timeout=720h']);
    await access.kubectl(inside, ['create', 'serviceaccount', 'koala', '-n', 'default']);
    await access.kubectl(inside, ['create', 'clusterrolebinding', 'koala', '--clusterrole=cluster-admin', '--serviceaccount=default:koala']);
    const token = (await access.kubectl(inside, ['create', 'token', 'koala', '-n', 'default', '--duration=1h'])).trim();
    const account: ServiceAccount = { host: nodeAddress, port: nodePort, caFile: join(folder, 'ca.crt'), tokenFile: join(folder, 'token') };
    writeFileSync(account.caFile, Buffer.from(/certificate-authority-data: (\S+)/.exec(admin)![1]!, 'base64').toString('utf8'), { mode: 0o600 });
    writeFileSync(account.tokenFile, token, { mode: 0o600 });
    return { namespace, admin, account, folder, stop: () => namespaces.removeAll() };
  } catch (failure) {
    await namespaces.removeAll();
    throw failure;
  }
}
