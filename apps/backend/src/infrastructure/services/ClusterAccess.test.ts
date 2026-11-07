import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { encryptValue, type ClusterMetadata, type Processes } from '../../platform/index.js';
import { MemoryInfrastructureStore } from '../testing/memory-store.js';
import { ClusterAccess, type ClusterAccessDeps } from './ClusterAccess.js';

const KEY = 'test-key' as never;
const ADMIN = 'apiVersion: v1\nkind: Config\nclusters: []\n';

const cluster = (overrides: Partial<ClusterMetadata>): ClusterMetadata =>
  ({ id: 'machine-dev2', name: 'machine-dev2', provider: 'machine', machineId: 'dev2', status: 'healthy', ownerId: 'owner', createdAt: 't', ...overrides }) as ClusterMetadata;

async function access(overrides: Partial<ClusterAccessDeps> = {}, records: ClusterMetadata[] = []): Promise<{ access: ClusterAccess; processes: ReturnType<typeof mock<Processes>>; folder: string }> {
  const store = new MemoryInfrastructureStore();
  for (const record of records) await store.saveCluster(record);
  const processes = mock<Processes>();
  processes.run.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
  const folder = mkdtempSync(join(tmpdir(), 'koala-cluster-access-'));
  return {
    access: new ClusterAccess({ clusters: store, here: { koalaMachineId: 'dev1', root: false }, folder, processes, tools: { kubectl: '/bin/kubectl', helm: '/bin/helm' }, dataKey: KEY, ...overrides }),
    processes,
    folder,
  };
}

describe('ClusterAccess, the one door to a cluster', () => {
  it('opens a machine\'s sealed kubeconfig into a file only its owner reads, and runs kubectl with it', async () => {
    const { access: door, processes, folder } = await access({}, [cluster({ kubeconfigEnc: encryptValue(ADMIN, KEY) })]);
    expect(await door.kubectl('machine-dev2', ['get', 'pods'], { input: 'x' })).toBe('ok');
    const where = join(folder, 'kubeconfig-machine-machine-dev2');
    expect(processes.run).toHaveBeenCalledWith({ command: '/bin/kubectl', args: ['--kubeconfig', where, 'get', 'pods'], input: 'x' });
    expect(readFileSync(where, 'utf8')).toBe(ADMIN);
    expect(statSync(where).mode & 0o777).toBe(0o600);
  });

  it('reaches Koala\'s own cluster through its pod\'s account, and refuses when the process is in no pod', async () => {
    const own = cluster({ id: 'machine-dev1', name: 'machine-dev1', machineId: 'dev1' });
    const inPod = await access({ serviceAccount: { host: '10.43.0.1', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' } }, [own]);
    await inPod.access.helm('machine-dev1', ['list', '-A']);
    expect(readFileSync(join(inPod.folder, 'kubeconfig-koala'), 'utf8')).toContain('server: https://10.43.0.1:443');
    const outside = await access({}, [own]);
    await expect(outside.access.kubectl('machine-dev1', ['get', 'ns'])).rejects.toMatchObject({ name: 'ClusterUnreachable', why: 'no-account' });
  });

  it('runs nothing when a cluster cannot be reached, and says why', async () => {
    const { access: door, processes } = await access({}, [cluster({ status: 'stopped' }), cluster({ id: 'old', name: 'old', provider: 'k3d' })]);
    await expect(door.kubectl('machine-dev2', ['get', 'ns'])).rejects.toMatchObject({ why: 'stopped', message: 'machine-dev2 is stopped until something runs on it' });
    await expect(door.kubectl('old', ['get', 'ns'])).rejects.toMatchObject({ why: 'other-kind' });
    await expect(door.kubectl('nowhere', ['get', 'ns'])).rejects.toMatchObject({ why: 'unknown' });
    expect(processes.run).not.toHaveBeenCalled();
  });

  it('takes a kubeconfig a workflow hands over for a machine it started, and for nothing else', async () => {
    const { access: door, folder } = await access({ dataKey: undefined }, [cluster({ status: 'stopped' }), cluster({ id: 'old', name: 'old', provider: 'hetzner' })]);
    await door.kubectl('machine-dev2', ['get', 'ns'], { handed: ADMIN });
    expect(readFileSync(join(folder, 'kubeconfig-handed-machine-dev2'), 'utf8')).toBe(ADMIN);
    await expect(door.kubectl('old', ['get', 'ns'], { handed: ADMIN })).rejects.toMatchObject({ why: 'other-kind' });
  });

  it('cannot open a sealed kubeconfig without the data key, and says the workflow hands it over', async () => {
    const { access: door } = await access({ dataKey: undefined }, [cluster({ kubeconfigEnc: encryptValue(ADMIN, KEY) })]);
    await expect(door.kubeconfigFor('machine-dev2')).rejects.toMatchObject({ why: 'no-key' });
  });

  it('reaches root\'s own cluster on root with the kubeconfig root was given, and refuses when none was', async () => {
    const onRoot = await access({ here: { root: true }, rootKubeconfig: '/etc/koala/root-cluster.yaml' });
    expect(await onRoot.access.kubeconfigFor('root')).toBe('/etc/koala/root-cluster.yaml');
    const unset = await access({ here: { root: true } });
    await expect(unset.access.kubeconfigFor('root')).rejects.toMatchObject({ why: 'not-configured' });
  });

  it('passes a failed command on with what the tool said', async () => {
    const { access: door, processes } = await access({}, [cluster({ kubeconfigEnc: encryptValue(ADMIN, KEY) })]);
    processes.run.mockResolvedValue({ code: 1, stdout: '', stderr: 'Error from server (NotFound): namespaces "shop" not found' });
    await expect(door.kubectl('machine-dev2', ['get', 'ns', 'shop'])).rejects.toThrow('namespaces "shop" not found');
  });
});
