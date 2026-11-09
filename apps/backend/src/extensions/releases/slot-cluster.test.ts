import { afterEach, describe, it, expect, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { existsSync, readFileSync } from 'fs';
import { Readable } from 'stream';
import { createSlotCluster, preparedNamespace, releaseCluster, releaseNamespace, type RepoFiles, type VaultSyncArgs } from './slot-cluster.js';
import { REGISTRY_PULL_SECRET } from '../../instances/lib/registry-pull.js';
import { NOTHING_INSTALLED } from '../../releases/lib/odoo-release.js';
import type { ClusterAccess } from '../../infrastructure/index.js';

describe('the namespace a release is installed in', () => {
  it('carries its owner and project, so removing either finds it', () => {
    expect(releaseNamespace({ namespace: 'shop-1a2b3c', owner: { ownerId: 'BO_1', projectId: 'project-p1' } })).toEqual({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'shop-1a2b3c', labels: { 'koala.dev/owner': 'bo_1', 'koala.dev/project': 'project-p1' } },
    });
  });

  it('is still named for a release started before releases said whose they are', () => {
    expect(releaseNamespace({ namespace: 'shop' })).toEqual({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } });
  });
});

const login = { hosts: { push: '10.0.0.130:31737', pull: '10.0.0.130:31737' }, username: 'provisioning-bot', password: 'tok' };
const target = { clusterId: 'machine-own', clusterName: 'own', provider: 'machine', namespace: 'shop-1a2b3c', release: 'shop-1a2b3c', owner: { ownerId: 'BO_1', projectId: 'project-p1' } };
const old = { clusterName: 'own', provider: 'hetzner', namespace: 'shop-1a2b3c', release: 'shop-1a2b3c' } as never;
const source = { owner: 'bo', repo: 'shop', commit: 'c0ffee' };

const prepared = (manifest: unknown) =>
  (((manifest as { items?: unknown[] }).items ?? []) as Record<string, unknown>[]).map((item) => `${item.kind}/${(item.metadata as { name: string }).name}`);

function made(options: { repo?: Partial<RepoFiles>; syncVault?: (args: VaultSyncArgs) => Promise<void> } = {}) {
  const access = mock<ClusterAccess>();
  access.apply.mockResolvedValue('');
  access.kubectl.mockResolvedValue('');
  access.helm.mockResolvedValue('');
  access.kubeconfigOf.mockResolvedValue('/tmp/koala-clusters/kubeconfig-machine-own');
  access.reach.mockImplementation(async (clusterId) => ({ clusterId, kind: 'machine', kubeconfig: 'apiVersion: v1\n' }));
  const repo: RepoFiles = { listPaths: async () => [], getRawFile: async () => null, ...options.repo };
  const asked: string[] = [];
  const beats: unknown[] = [];
  const cluster = createSlotCluster({
    access,
    repo: async () => repo,
    registry: async () => { asked.push('login'); return login; },
    syncVault: options.syncVault ?? (async () => undefined),
    beat: (detail) => { beats.push(detail); },
  });
  const applied = () => access.apply.mock.calls.map(([where, manifest]) => ({ where, manifest: JSON.parse(manifest) as Record<string, unknown> }));
  return { access, cluster, asked, beats, applied };
}

afterEach(() => { vi.useRealTimers(); });

describe('the cluster a release reaches', () => {
  it('is the one its target names', () => {
    expect(releaseCluster(target)).toBe('machine-own');
  });

  it('is refused for a release started before targets named their cluster, so nothing is reached', async () => {
    expect(() => releaseCluster(old)).toThrow(/started before releases named their cluster by id, so own cannot be reached/);
    const { access, cluster } = made();
    await expect(cluster.state(old)).rejects.toThrow(/started before releases named their cluster by id/);
    await expect(cluster.scale(old, 'deployment/x', 0)).rejects.toThrow(/started before/);
    expect(access.helm).not.toHaveBeenCalled();
    expect(access.kubectl).not.toHaveBeenCalled();
  });
});

describe('a release namespace pulls Koala-built images with a login', () => {
  it('names the namespace, its pull secret and its default service account in one list', () => {
    const list = preparedNamespace(target, login);
    expect(prepared(list)).toEqual(['Namespace/shop-1a2b3c', `Secret/${REGISTRY_PULL_SECRET}`, 'ServiceAccount/default']);
    expect((list.items as Record<string, unknown>[])[2]).toMatchObject({ metadata: { namespace: 'shop-1a2b3c' }, imagePullSecrets: [{ name: REGISTRY_PULL_SECRET }] });
  });

  it('is prepared before a job, a put, the vault and when asked, each with the login it is handed, on the target\'s cluster', async () => {
    const { access, cluster, asked, applied } = made();
    access.kubectl.mockImplementation(async (_at, args) => {
      if (args.includes('jsonpath={.status.succeeded}|{.status.failed}')) return '1|0';
      if (args.includes('jsonpath={.data}')) return JSON.stringify({ POSTGRES_PASSWORD: 'eA==' });
      return '';
    });

    await cluster.job(target, 'shop-init', { apiVersion: 'batch/v1', kind: 'Job', metadata: {}, spec: {} });
    expect(prepared(applied()[0]!.manifest)).toEqual(['Namespace/shop-1a2b3c', `Secret/${REGISTRY_PULL_SECRET}`, 'ServiceAccount/default']);
    expect(applied()[1]).toMatchObject({ where: 'machine-own', manifest: { kind: 'Job', metadata: { name: 'shop-init', namespace: 'shop-1a2b3c' } } });

    access.apply.mockClear();
    await cluster.put(target, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' } });
    expect(prepared(applied()[0]!.manifest)).toContain('ServiceAccount/default');
    expect(applied()[1]).toEqual({ where: 'machine-own', manifest: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c', namespace: 'shop-1a2b3c' } } });

    access.apply.mockClear();
    await cluster.vault(target, { projectId: 'project-p1', secret: 'shop-vault', keys: ['POSTGRES_PASSWORD'] } as never);
    expect(prepared(applied()[0]!.manifest)).toContain(`Secret/${REGISTRY_PULL_SECRET}`);

    access.apply.mockClear();
    await cluster.pullAccess(target);
    expect(applied()).toEqual([{ where: 'machine-own', manifest: preparedNamespace(target, login) }]);
    expect(asked).toHaveLength(4);
    expect(access.kubectl.mock.calls.every(([where]) => where === 'machine-own')).toBe(true);
  });
});

describe('what is installed in the slots', () => {
  it('is read from the release\'s helm values on its cluster', async () => {
    const { access, cluster } = made();
    access.helm.mockResolvedValue(JSON.stringify({ live: 'b', slots: { a: { tag: '1' }, b: { tag: '2' } } }));
    expect(await cluster.state(target)).toEqual({ installed: true, live: 'b', tags: { a: '1', b: '2' } });
    expect(access.helm).toHaveBeenCalledWith('machine-own', ['get', 'values', 'shop-1a2b3c', '-n', 'shop-1a2b3c', '-o', 'json']);
  });

  it('is nothing while helm has no such release, and any other failure is thrown', async () => {
    const { access, cluster } = made();
    access.helm.mockRejectedValueOnce(new Error('Error: release: not found'));
    expect(await cluster.state(target)).toEqual(NOTHING_INSTALLED);
    access.helm.mockRejectedValueOnce(new Error('connection refused'));
    await expect(cluster.state(target)).rejects.toThrow('connection refused');
  });
});

describe('the build\'s files', () => {
  it('are listed and read at the build\'s commit', async () => {
    const { cluster } = made({ repo: { listPaths: async (owner, repo, commit) => [`${owner}/${repo}@${commit}`], getRawFile: async (_o, _r, file) => `<${file}>` } });
    expect(await cluster.files(source)).toEqual(['bo/shop@c0ffee']);
    expect(await cluster.file(source, 'a.txt')).toBe('<a.txt>');
  });
});

describe('installing the chart a build holds', () => {
  it('refuses a build with no chart, reaching no cluster', async () => {
    const { access, cluster } = made({ repo: { listPaths: async () => ['addons/x.py'] } });
    await expect(cluster.apply(target, source, [])).rejects.toThrow('bo/shop has no deploy/chart/Chart.yaml at c0ffee');
    expect(access.helm).not.toHaveBeenCalled();
  });

  it('prepares the namespace, then upgrades the release from the chart\'s files on the target\'s cluster, leaving no copy behind', async () => {
    const files: Record<string, string | null> = { 'deploy/chart/Chart.yaml': 'name: shop\n', 'deploy/chart/templates/a.yaml': 'kind: A\n', 'deploy/chart/gone.yaml': null, 'addons/x.py': 'x' };
    const { access, cluster, applied } = made({ repo: { listPaths: async () => Object.keys(files), getRawFile: async (_o, _r, file) => files[file] ?? null } });
    let chartDir = '';
    const seen: Record<string, string | boolean> = {};
    access.helm.mockImplementation(async (_at, args) => {
      chartDir = args[3]!;
      seen.chart = readFileSync(`${chartDir}/Chart.yaml`, 'utf8');
      seen.template = readFileSync(`${chartDir}/templates/a.yaml`, 'utf8');
      seen.gone = existsSync(`${chartDir}/gone.yaml`);
      return '';
    });
    await cluster.apply(target, source, ['--set', 'live=a']);
    expect(seen).toEqual({ chart: 'name: shop\n', template: 'kind: A\n', gone: false });
    expect(applied()[0]).toEqual({ where: 'machine-own', manifest: preparedNamespace(target, login) });
    expect(access.helm).toHaveBeenCalledWith('machine-own', ['upgrade', '--install', 'shop-1a2b3c', chartDir, '-n', 'shop-1a2b3c', '--create-namespace', '--set', 'live=a']);
    expect(existsSync(chartDir)).toBe(false);
  });
});

describe('the release\'s vault', () => {
  it('is synced with runners on the target\'s cluster and waits until every key is in the secret', async () => {
    vi.useFakeTimers();
    let handed: VaultSyncArgs | undefined;
    const { access, cluster, beats } = made({ syncVault: async (args) => { handed = args; } });
    let reads = 0;
    access.kubectl.mockImplementation(async (_at, args) => {
      if (args.includes('jsonpath={.data}')) {
        reads += 1;
        if (reads === 1) throw new Error('Error from server (NotFound): secrets "shop-vault" not found');
        return JSON.stringify({ POSTGRES_PASSWORD: 'eA==', ODOO_ADMIN_PASSWORD: 'eQ==' });
      }
      return 'ran';
    });
    access.helm.mockResolvedValue('helm');
    access.apply.mockResolvedValue('applied');
    const done = cluster.vault(target, { projectId: 'project-p1', secret: 'shop-vault', keys: ['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD'] } as never);
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(handed).toMatchObject({ projectId: 'project-p1', namespace: 'shop-1a2b3c', secretName: 'shop-vault', kubeconfig: '/tmp/koala-clusters/kubeconfig-machine-own', reach: { clusterId: 'machine-own', kind: 'machine' } });
    expect(access.reach).toHaveBeenCalledWith('machine-own');
    expect(access.kubeconfigOf).toHaveBeenCalledWith('machine-own');
    expect(await handed!.cluster.runKubectl(['get', 'ns'])).toBe('ran');
    expect(await handed!.cluster.runHelm(['status', 'x'])).toBe('helm');
    expect(await handed!.cluster.applyManifest('{}')).toBe('applied');
    expect(access.kubectl).toHaveBeenCalledWith('machine-own', ['get', 'ns']);
    expect(access.helm).toHaveBeenCalledWith('machine-own', ['status', 'x']);
    expect(access.apply).toHaveBeenCalledWith('machine-own', '{}');
    expect(beats).toEqual([['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD'], ['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD']]);
  });

  it('throws a failure to read the secret that is not its absence', async () => {
    const { access, cluster } = made();
    access.kubectl.mockRejectedValue(new Error('forbidden'));
    await expect(cluster.vault(target, { projectId: 'p', secret: 's', keys: ['K'] } as never)).rejects.toThrow('forbidden');
  });
});

describe('working in the release\'s namespace', () => {
  it('runs, scales and removes with kubectl in the namespace on the target\'s cluster', async () => {
    const { access, cluster, beats } = made();
    access.kubectl.mockResolvedValue('out');
    expect(await cluster.exec(target, 'pod-1', ['echo', 'hi'])).toBe('out');
    await cluster.scale(target, 'deployment/shop-a', 0);
    await cluster.remove(target, 'pod', 'helper');
    await cluster.remove(target, 'job', 'init', true);
    expect(access.kubectl.mock.calls).toEqual([
      ['machine-own', ['-n', 'shop-1a2b3c', 'exec', 'pod-1', '--', 'echo', 'hi']],
      ['machine-own', ['-n', 'shop-1a2b3c', 'scale', 'deployment/shop-a', '--replicas=0']],
      ['machine-own', ['-n', 'shop-1a2b3c', 'delete', 'pod', 'helper', '--ignore-not-found', '--wait=false']],
      ['machine-own', ['-n', 'shop-1a2b3c', 'delete', 'job', 'init', '--ignore-not-found', '--wait=true', '--cascade=foreground']],
    ]);
    expect(beats).toEqual([undefined, 'helper', 'init']);
  });

  it('pipes into a pod through kubectl exec -i on the target\'s cluster', async () => {
    const { access, cluster } = made();
    access.pipe.mockResolvedValue('restored');
    const input = Readable.from(['dump']);
    expect(await cluster.pipe(target, 'pod-1', ['psql'], input)).toBe('restored');
    expect(access.pipe).toHaveBeenCalledWith('machine-own', ['-n', 'shop-1a2b3c', 'exec', '-i', 'pod-1', '--', 'psql'], input);
  });

  it('waits for a rollout on the target\'s cluster', async () => {
    const { access, cluster } = made();
    access.kubectl.mockResolvedValue(JSON.stringify({ items: [{ kind: 'Deployment', metadata: { name: 'shop-a', generation: 1 }, spec: { replicas: 0 }, status: { observedGeneration: 1 } }] }));
    await cluster.waitReady(target, 'deployment/shop-a');
    expect(access.kubectl).toHaveBeenCalledWith('machine-own', ['-n', 'shop-1a2b3c', 'get', 'deployments,statefulsets,daemonsets,replicasets,jobs,pods', '-o', 'json']);
  });
});

describe('waiting for a pod to run', () => {
  it('returns once it runs, polling while it is absent or pending', async () => {
    vi.useFakeTimers();
    const { access, cluster } = made();
    const phases = ['', 'Pending', 'Running'];
    access.kubectl.mockImplementation(async (_at, args) => {
      if (args.includes('jsonpath={.status.phase}')) {
        const phase = phases.shift()!;
        if (phase === '') throw new Error('pods "helper" not found');
        return phase;
      }
      return JSON.stringify({ status: { phase: 'Pending' } });
    });
    const done = cluster.running(target, 'helper');
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(phases).toEqual([]);
  });

  it('refuses a pod that ended or cannot run', async () => {
    const { access, cluster } = made();
    access.kubectl.mockResolvedValueOnce('Failed');
    await expect(cluster.running(target, 'helper')).rejects.toThrow('helper stopped (Failed) before it could be used');
    access.kubectl.mockImplementation(async (_at, args) => (args.includes('jsonpath={.status.phase}')
      ? 'Pending'
      : JSON.stringify({ metadata: { name: 'helper' }, status: { phase: 'Pending', containerStatuses: [{ name: 'c', state: { waiting: { reason: 'ImagePullBackOff', message: 'no such image' } } }] } })));
    await expect(cluster.running(target, 'helper')).rejects.toThrow(/helper cannot run/);
  });
});
