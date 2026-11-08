import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ClusterUnreachable, type ClusterAccess, type InfisicalService, type InfrastructureService, type Reach } from '../infrastructure/index.js';
import type { GiteaService } from '../projects/index.js';
import type { Database } from '../platform/index.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import type { DeployAppArgs } from './DeployAppActivity.js';

const records = vi.hoisted(() => ({ db: undefined as Database | undefined }));

vi.mock('../platform/index.js', async (actual) => ({
  ...(await actual<typeof import('../platform/index.js')>()),
  createDatabase: () => records.db!,
}));

const { DeployAppActivity } = await import('./DeployAppActivity.js');

const DESK: Reach = { clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1\nkind: Config\n' };
const LOG = join(mkdtempSync(join(tmpdir(), 'deploy-app-')), 'deploy.log');
const PROBES = 'probes.monitoring.coreos.com\n';

let access: MockProxy<ClusterAccess>;
let infra: MockProxy<InfrastructureService>;
let reached: Reach[];
let nodes: string;

const steps = () => ({ access, infra, gitea: mock<GiteaService>(), infisical: mock<InfisicalService>() });

const deploy = (over: Partial<DeployAppArgs> = {}): DeployAppArgs => ({
  name: 'blog', namespace: 'blog-1a2b3c', clusterId: 'machine-desk', reach: DESK, clusterName: 'desk',
  machine: { deviceId: 'desk' }, strategy: 'native', appType: 'wordpress', odooRepo: '', odooTag: '', dbRepo: '', dbTag: '',
  logFile: LOG, deploymentId: 'd1', ...over,
});

beforeEach(async () => {
  records.db = memoryDatabase();
  await records.db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy' } as never);
  access = mock<ClusterAccess>();
  infra = mock<InfrastructureService>();
  reached = [];
  nodes = '64Gi';
  access.kubeconfigOf.mockImplementation(async (target) => `/clusters/kubeconfig-${(target as Reach).clusterId}`);
  access.apply.mockImplementation(async (target) => { reached.push(target as Reach); return ''; });
  access.kubectl.mockImplementation(async (target, args) => {
    reached.push(target as Reach);
    if (args[0] === 'api-resources') return PROBES;
    if (args[0] === 'get' && args[1] === 'service') return `service/${args[2]}`;
    if (args[0] === 'get' && args[1] === 'nodes') return nodes;
    if (args[0] === 'create' && args.includes('--dry-run=client')) return 'apiVersion: v1\nkind: Secret\n';
    return '';
  });
  infra.deploy.mockResolvedValue({ stdout: '', logFile: LOG });
});

describe('deploying an app on the cluster it was handed', () => {
  it('applies the app\'s stack with that cluster\'s kubeconfig and no context, and reaches nothing else', async () => {
    const done = await DeployAppActivity(deploy(), steps());
    expect(done.status).toBe('running');
    expect(infra.deploy).toHaveBeenCalledWith('app-desk-d1', { logFile: LOG, env: expect.objectContaining({ KUBECONFIG: '/clusters/kubeconfig-machine-desk', CLUSTER_NAME: 'desk', DEPLOYMENT_NAME: 'blog-1a2b3c', APP_SERVICE_TYPE: 'NodePort' }) as unknown });
    expect(infra.deploy.mock.calls.at(-1)![1]?.env).not.toHaveProperty('KUBECONFIG_CONTEXT');
    expect(infra.deploy.mock.calls.at(-1)![1]?.env).not.toHaveProperty('SELF_MANAGED_K8S');
    expect(new Set(reached)).toEqual(new Set([DESK]));
    expect(access.kubeconfigOf.mock.calls.every(([target]) => target === DESK)).toBe(true);
  });

  it('gives a machine\'s cluster its collectors first, named for the cluster\'s id, with a metrics token whose hash only is kept on the cluster\'s record', async () => {
    access.kubectl.mockImplementation(async (target, args) => {
      reached.push(target as Reach);
      if (args[0] === 'get' && args[1] === 'nodes') return nodes;
      return '';
    });
    await DeployAppActivity(deploy(), steps());
    expect(access.apply.mock.calls.map(([target, manifest]) => [target, (JSON.parse(manifest) as { kind: string }).kind])).toEqual([[DESK, 'Namespace'], [DESK, 'Secret']]);
    expect(infra.deploy.mock.calls.map(([stack]) => stack)).toEqual(['machine-desk', 'app-desk-d1']);
    expect(infra.deploy.mock.calls[0]![1]).toMatchObject({ env: { CLUSTER_NAME: 'machine-desk', KUBECONFIG_PATH: '/clusters/kubeconfig-machine-desk', CLUSTER_MONITORING: 'agent', INGRESS_SERVICE: 'NodePort' } });
    expect(infra.deploy.mock.calls[0]![1]?.env).not.toHaveProperty('ENV');
    expect(infra.deploy.mock.calls[0]![1]?.env).not.toHaveProperty('KOALA_CLUSTER');
    expect((await records.db!.infrastructure.getClusters())[0]?.metricsTokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reads the nodes\' memory through the cluster it was handed to plan TabbyAPI\'s, and refuses a node too small', async () => {
    nodes = '1Gi';
    await expect(DeployAppActivity(deploy({ appType: 'tabbyapi', tabbyGpuCount: 1, tabbyMaxSeqLen: 32768 }), steps())).rejects.toThrow(/of host RAM but only .* is available on the node \(1\.0 GiB allocatable/);
    expect(access.kubectl).toHaveBeenCalledWith(DESK, ['get', 'nodes', '-o', 'jsonpath={.items[*].status.allocatable.memory}']);
    expect(infra.deploy.mock.calls.map(([stack]) => stack)).not.toContain('app-desk-d1');
  });

  it('makes Palworld\'s passwords on that cluster when it has none, and restarts it there', async () => {
    await DeployAppActivity(deploy({ appType: 'palworld' }), steps());
    expect(access.apply).toHaveBeenCalledWith(DESK, 'apiVersion: v1\nkind: Secret\n');
    expect(access.kubectl).toHaveBeenCalledWith(DESK, ['rollout', 'restart', 'deployment/palworld', '-n', 'blog-1a2b3c']);
  });

  it('refuses Odoo modules to bake into an image before it touches any cluster, since no cluster pulls from this computer\'s Docker', async () => {
    await expect(DeployAppActivity(deploy({ appType: 'odoo', modules: ['sale'] }), steps())).rejects.toThrow('release the modules through the project\'s repository instead');
    expect(access.kubectl).not.toHaveBeenCalled();
    expect(infra.deploy).not.toHaveBeenCalled();
  });

  it('fails with why when the cluster cannot be reached, and applies nothing', async () => {
    access.kubeconfigOf.mockRejectedValue(new ClusterUnreachable('machine-desk', 'no-account', 'this process is not running inside Koala\'s cluster'));
    await expect(DeployAppActivity(deploy(), steps())).rejects.toThrow('not running inside Koala\'s cluster');
    expect(infra.deploy).not.toHaveBeenCalled();
  });

  it('on Koala\'s servers, keeps an app on the pool place it runs in behind a ClusterIP with the pool\'s storage, and gives that place only the operator\'s resources', async () => {
    const POOL: Reach = { clusterId: 'pool-bob', kind: 'koala' };
    vi.stubEnv('POOL', 'true');
    try {
      access.kubectl.mockImplementation(async (_target, args) => (args[0] === 'api-resources' || (args[0] === 'get' && args[1] === 'ingressclass') ? '' : ''));
      await DeployAppActivity(deploy({ clusterId: 'pool-bob', reach: POOL, clusterName: 'pool-bob', machine: undefined }), steps());
      const [monitoring, app] = infra.deploy.mock.calls;
      expect([monitoring![0], monitoring![1]?.env]).toEqual(['pool-bob', expect.objectContaining({ CLUSTER_NAME: 'pool-bob', CLUSTER_MONITORING: 'crds', INGRESS_SERVICE: 'ClusterIP' })]);
      expect([app![0], app![1]?.env]).toEqual(['app-pool-bob-d1', expect.objectContaining({ APP_SERVICE_TYPE: 'ClusterIP', MINIO_STORAGE: '10Gi' })]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gives Koala\'s own cluster its whole monitoring as Koala\'s, behind a NodePort ingress, with no metrics token', async () => {
    const OWN: Reach = { clusterId: 'machine-home', kind: 'koala' };
    access.kubectl.mockImplementation(async (target, args) => {
      reached.push(target as Reach);
      if (args[0] === 'get' && args[1] === 'nodes') return nodes;
      return '';
    });
    await DeployAppActivity(deploy({ clusterId: 'machine-home', reach: OWN, clusterName: 'home', machine: undefined }), steps());
    const [monitoring, observability, app] = infra.deploy.mock.calls;
    expect([monitoring![0], monitoring![1]?.env]).toEqual(['machine-home', expect.objectContaining({ CLUSTER_NAME: 'machine-home', KOALA_CLUSTER: 'true', INGRESS_SERVICE: 'NodePort' })]);
    expect(monitoring![1]?.env).not.toHaveProperty('CLUSTER_MONITORING');
    expect(monitoring![1]?.env).not.toHaveProperty('ENV');
    expect(observability![0]).toBe('machine-home-observability');
    expect([app![0], app![1]?.env]).toEqual(['app-home-d1', expect.objectContaining({ APP_SERVICE_TYPE: 'NodePort' })]);
    expect(access.apply).not.toHaveBeenCalled();
  });

  it('is refused when it was handed no way to reach the cluster', async () => {
    await expect(DeployAppActivity(deploy({ reach: undefined }), steps())).rejects.toThrow('handed no way to reach machine-desk');
    expect(infra.deploy).not.toHaveBeenCalled();
  });
});
