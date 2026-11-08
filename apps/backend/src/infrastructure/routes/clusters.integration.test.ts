import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { mock } from 'vitest-mock-extended';
import { clustersRouter } from './clusters.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { ClusterMetadata } from '../../platform/lib/types.js';
import { encryptValue } from '../../platform/lib/crypto.js';
import { temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { TemporalBridge } from '../services/TemporalBridge.js';
import { CredentialService } from '../services/CredentialService.js';
import { ClusterService } from '../services/ClusterService.js';
import { ClusterProxyService } from '../services/ClusterProxyService.js';
import { InfisicalService } from '../services/InfisicalService.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import { GiteaService } from '../../projects/services/GiteaService.js';
import { testClusterAccess } from '../testing/cluster-access.js';

const ANY_STATUS = { validateStatus: () => true };
const KEY = 'test-secret';
const KOALAS = 'machine-koala-box';
const NO_GPUS = { hasGpu: false, vendor: 'none', totalCapacity: 0, totalAllocatable: 0, totalAllocated: 0, availableGpus: 0, nodes: [], devicePlugins: [], gpuPods: [] };
const NODES = ['get', 'nodes', '-o', 'json'];

let env: TestWorkflowEnvironment;
let grafana: http.Server;
let grafanaUrl: string;
const grafanaLogins: string[] = [];
let kubeconfigDir: string;

beforeAll(async () => {
  env = await temporalTestEnvironment();
  kubeconfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clusters-route-'));
  grafana = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/login') {
        grafanaLogins.push(body);
        response.setHeader('set-cookie', 'grafana_session=signed-in; Path=/; HttpOnly');
        response.end(JSON.stringify({ message: 'Logged in' }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise<void>((resolve) => grafana.listen(0, '127.0.0.1', () => resolve()));
  grafanaUrl = `http://127.0.0.1:${(grafana.address() as AddressInfo).port}/`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => grafana.close(() => resolve()));
  await fs.rm(kubeconfigDir, { recursive: true, force: true });
  await env?.teardown();
});

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const infraOnHost = (unreachable?: string) => {
  const infra = mock<InfrastructureService>();
  infra.getKubeconfig.mockImplementation(async (name) => `apiVersion: v1\nkind: Config\ncurrent-context: k3d-${name}\n`);
  infra.listLocalClusters.mockResolvedValue([]);
  infra.runHelm.mockResolvedValue('[]');
  infra.runKubectl.mockImplementation(async (args) => {
    if (unreachable) throw new Error(unreachable);
    if (args[0] === 'get' && args[1] === 'secret') return Buffer.from('grafana-admin-password').toString('base64');
    return JSON.stringify({ items: [] });
  });
  return infra;
};

const spiesOn = (clusterService: ClusterService, clusterProxyService: ClusterProxyService, bridge: TemporalBridge) => ({
  getAll: vi.spyOn(clusterService, 'getAll'),
  getById: vi.spyOn(clusterService, 'getById'),
  getGpuStatus: vi.spyOn(clusterService, 'getGpuStatus'),
  ensurePortForward: vi.spyOn(clusterProxyService, 'ensurePortForward').mockImplementation(async (clusterId, serviceKey) => (serviceKey === 'grafana' ? grafanaUrl : `${grafanaUrl}${clusterId}/${serviceKey}/`)),
  getAutoLoginCookies: vi.spyOn(clusterProxyService, 'getAutoLoginCookies'),
  provision: vi.spyOn(bridge, 'provision'),
});

interface Mounted {
  h: Harness;
  db: Database;
  infra: ReturnType<typeof infraOnHost>;
  clusterService: ClusterService;
  bridge: TemporalBridge;
  spies: ReturnType<typeof spiesOn>;
}

interface MountOptions {
  user?: typeof TEST_USER | null;
  instanceOwner?: string | undefined;
  temporal?: boolean;
  koalaMachineId?: string | undefined;
  unreachable?: string;
  seed?: (db: Database) => Promise<void>;
}


const seedOwnCluster = async (db: Database) => {
  const sealed = encryptValue('apiVersion: v1\nkind: Config\n', KEY);
  await db.infrastructure.saveCluster({ id: 'c1', name: 'dev', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: TEST_USER.id, kubeconfigEnc: sealed } as ClusterMetadata);
  await db.infrastructure.saveCluster({ id: 'someone-elses', name: 'theirs', provider: 'machine', machineId: 'nas', status: 'healthy', ownerId: 'someone-else', kubeconfigEnc: sealed } as ClusterMetadata);
};

const mount = async (options: MountOptions = {}): Promise<Mounted> => {
  let made: Omit<Mounted, 'h' | 'db'> | undefined;
  const user = options.user === undefined ? TEST_USER : options.user;
  h = await mountRouter({
    prefix: '/api/clusters',
    user,
    claims: { role: 'instance', instanceOwnerId: options.instanceOwner ?? TEST_USER.id },
    router: async (db) => {
      if (user) await db.accounts.saveUser({ id: user.id, email: user.email, twoFactorEnabled: false, emailVerified: true, createdAt: 'then', roles: user.roles ?? [] } as never);
      await seedOwnCluster(db);
      await options.seed?.(db);
      const infra = infraOnHost(options.unreachable);
      const koalaMachineId = 'koalaMachineId' in options ? options.koalaMachineId : 'koala-box';
      const clusterService = new ClusterService(db, infra, testClusterAccess(db, { answers: (args) => infra.runKubectl([...args], 'through-cluster-access'), dataKey: KEY, koalaMachineId, folder: kubeconfigDir, serviceAccount: { host: 'kubernetes.default.svc', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' } }), { kubeconfigDir, instanceOwnerId: options.instanceOwner ?? TEST_USER.id });
      const clusterProxyService = new ClusterProxyService(clusterService.access);
      const bridge = new TemporalBridge(db, undefined, KEY, clusterService);
      if (options.temporal) bridge.client = env.client;
      made = {
        infra,
        clusterService,
        bridge,
        spies: spiesOn(clusterService, clusterProxyService, bridge),
      };
      return clustersRouter({
        clusterService,
        clusterProxyService,
        access: clusterService.access,
        temporalBridge: bridge,
        io: { emit: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })) } as never,
        giteaService: new GiteaService(KEY, { none: 'these routes are tested without a Gitea' }),
        infisicalService: new InfisicalService(KEY, { none: 'these routes are tested without an Infisical' }),
      });
    },
  });
  return { h: h!, db: h!.db, ...made! };
};

describe('listing clusters', () => {
  it('returns only what the caller owns, scoped by the session', async () => {
    const { h, spies } = await mount();
    const res = await axios.get<ClusterMetadata[]>(h.url('/api/clusters'));
    expect(res.status).toBe(200);
    expect(spies.getAll).toHaveBeenCalledWith(expect.objectContaining({ id: TEST_USER.id }), expect.anything());
    expect(res.data.map((cluster) => cluster.id)).toEqual([KOALAS, 'c1']);
  });

  it('refuses an unauthenticated caller', async () => {
    const { h } = await mount({ user: null });
    await expect(axios.get(h.url('/api/clusters'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});

describe('reading one cluster', () => {
  it('404s for a cluster owned by someone else, not 403', async () => {
    const { h } = await mount();
    const err = await axios.get<unknown>(h.url('/api/clusters/someone-elses/proxy/grafana'), ANY_STATUS);
    expect(err.status).toBe(404);
    expect(JSON.stringify(err.data)).not.toMatch(/permission|forbidden|owner/i);
  });

  it('404s identically for an id that does not exist', async () => {
    const { h } = await mount();
    const err = await axios.get<unknown>(h.url('/api/clusters/no-such-thing/proxy/grafana'), ANY_STATUS);
    expect(err.status).toBe(404);
  });

  it('passes the calling user down to every lookup', async () => {
    const { h, spies } = await mount();
    h.setUser({ id: 'someone-else', email: 'other@example.com' });
    await axios.get(h.url('/api/clusters/c1/gpu-status')).catch(() => undefined);
    expect(spies.getById).toHaveBeenCalledWith('c1', expect.objectContaining({ id: 'someone-else' }), 'see-everything');
  });
});

describe('creating a cluster', () => {
  it('rejects a name that would break deep inside CDKTF, before anything is billed', async () => {
    const { h, spies } = await mount();
    const err = await axios.post<unknown>(h.url('/api/clusters'), { name: 'has spaces' }, ANY_STATUS);
    expect(err.status).toBe(400);
    expect(spies.provision).not.toHaveBeenCalled();
  });

  it('reports Temporal being down as 503, not as a bad request', async () => {
    const { h } = await mount();
    const err = await axios.post<unknown>(h.url('/api/clusters'), { name: 'valid-name', provider: 'k3d' }, ANY_STATUS);
    expect(err.status).toBe(503);
  });
});

describe('the dashboard proxies', () => {
  it('exposes one route per service and 404s an unknown cluster on each', async () => {
    const { h } = await mount();
    for (const service of ['prometheus', 'grafana', 'traefik', 'gitea', 'alertmanager', 'infisical']) {
      const err = await axios.get<unknown>(h.url(`/api/clusters/no-such-cluster/proxy/${service}`), ANY_STATUS);
      expect(err.status, service).toBe(404);
    }
  });
});

describe('what only whoever owns a cluster may open', () => {
  const PROXIES = ['prometheus', 'grafana', 'traefik', 'gitea', 'alertmanager', 'infisical'];
  const someone = { id: 'someone', email: 'someone@example.com' };
  const admin = { id: 'an-admin', email: 'admin@example.com', roles: ['operator' as const] };

  it('answers someone who does not own the cluster Koala runs in exactly as for an unknown one, and opens nothing', async () => {
    const { h, spies, infra } = await mount({ user: someone });
    for (const service of PROXIES) {
      const err = await axios.get<unknown>(h.url(`/api/clusters/${KOALAS}/proxy/${service}`), { maxRedirects: 0, ...ANY_STATUS });
      expect(err.status, service).toBe(404);
      expect(err.data, service).toEqual({ error: 'Cluster not found' });
    }
    const gpu = await axios.get<unknown>(h.url(`/api/clusters/${KOALAS}/gpu-status`), ANY_STATUS);
    expect(gpu.status).toBe(404);
    expect(gpu.data).toEqual({ error: 'Cluster not found' });
    expect(spies.ensurePortForward).not.toHaveBeenCalled();
    expect(spies.getAutoLoginCookies).not.toHaveBeenCalled();
    expect(infra.runKubectl.mock.calls.map(([args]) => args)).toEqual(Array.from({ length: PROXIES.length + 1 }, () => NODES));
    expect(spies.getGpuStatus).not.toHaveBeenCalled();
  });

  it('on an instance, refuses an admin who is not its owner', async () => {
    const { h, spies } = await mount({ user: admin, instanceOwner: 'the-owner' });
    const err = await axios.get<unknown>(h.url(`/api/clusters/${KOALAS}/proxy/grafana`), { maxRedirects: 0, ...ANY_STATUS });
    expect(err.status).toBe(404);
    expect(spies.ensurePortForward).not.toHaveBeenCalled();
  });

  it('opens the dashboards and GPUs of the cluster Koala runs on to the instance\'s owner', async () => {
    grafanaLogins.length = 0;
    const { h, spies } = await mount({ user: someone, instanceOwner: 'someone', koalaMachineId: 'koala-box' });
    const res = await axios.get<unknown>(h.url('/api/clusters/machine-koala-box/proxy/grafana'), { maxRedirects: 0, ...ANY_STATUS });
    expect(res.status).toBe(302);
    expect(spies.getAutoLoginCookies).toHaveBeenCalled();
    expect(String(res.headers['set-cookie'])).toContain('grafana_session=signed-in');
    expect(grafanaLogins.map((body) => JSON.parse(body) as unknown)).toEqual([{ user: 'admin', password: 'grafana-admin-password' }]);
    expect((await axios.get(h.url('/api/clusters/machine-koala-box/gpu-status'))).data).toEqual(NO_GPUS);
  });

  it('hides the cluster Koala runs in from anyone else who would delete it, and keeps it for its owner, whose machine takes it with it', async () => {
    const { h, spies } = await mount({ user: someone });
    const deleted = await axios.delete<unknown>(h.url(`/api/clusters/${KOALAS}`), ANY_STATUS);
    expect([deleted.status, deleted.data]).toEqual([404, { error: 'Cluster not found' }]);
    await h.close();
    const asOwner = await mount();
    const destroy = vi.spyOn(asOwner.bridge, 'destroyCluster');
    const ownerDeletes = await axios.delete<unknown>(asOwner.h.url(`/api/clusters/${KOALAS}`), ANY_STATUS);
    expect([ownerDeletes.status, ownerDeletes.data]).toEqual([409, { error: 'This is the cluster this Koala runs in; it goes only with its machine, removed under My Machines' }]);
    expect(destroy).not.toHaveBeenCalled();
    expect(spies.ensurePortForward).not.toHaveBeenCalled();
  });

  it('opens a cluster of the caller\'s own', async () => {
    const { h, spies } = await mount();
    const res = await axios.get(h.url('/api/clusters/c1/proxy/prometheus'));
    expect(res.status).toBe(200);
    expect(spies.ensurePortForward).toHaveBeenCalledWith('c1', 'prometheus');
    expect((await axios.get(h.url('/api/clusters/c1/gpu-status'))).data).toEqual(NO_GPUS);
  });
});

describe('when the cluster cannot be reached', () => {
  it('answers rather than hanging', async () => {
    const { h } = await mount({ koalaMachineId: 'koala-box', instanceOwner: TEST_USER.id, unreachable: 'dial tcp: i/o timeout' });
    await expect(axios.get(h.url('/api/clusters/machine-koala-box/gpu-status'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500, data: { error: 'dial tcp: i/o timeout' } },
    });
  });
});

describe('which providers Koala makes a cluster on', () => {
  async function withBridge(roles: ('operator')[] = []) {
    const mounted = await mount({ user: { ...TEST_USER, roles } as typeof TEST_USER, temporal: true });
    const start = vi.spyOn(env.client.workflow, 'start');
    return { ...mounted, start };
  }

  const settled = async (mounted: Mounted, workflowId: string) => {
    const cluster = (await mounted.db.infrastructure.getClusters()).find((entry) => entry.temporalWorkflowId === workflowId);
    await env.client.workflow.getHandle(workflowId).terminate('the test has seen it start');
    await mounted.bridge.follow(workflowId, 'cluster-provision', cluster?.id ?? '', cluster?.name ?? '', cluster?.provider ?? '');
  };

  const refusedAsStub = async (setup: () => ReturnType<typeof withBridge>, provider = 'aws') => {
    const { h: harness, db, start } = await setup();
    const err = await axios.post<unknown>(harness.url('/api/clusters'), { name: 'valid-name', provider }, ANY_STATUS);
    expect(err.status).toBe(400);
    expect((await db.infrastructure.getClusters()).map((cluster) => cluster.id).sort()).toEqual(['c1', 'someone-elses']);
    expect(start).not.toHaveBeenCalled();
    await h?.close();
    h = undefined;
    vi.restoreAllMocks();
    return (err.data as { error: string }).error;
  };

  it('in production refuses AWS, Google Cloud and Azure as not available yet, keys or none, recording and starting nothing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(await refusedAsStub(() => withBridge())).toBe('Amazon Web Services is not available yet');
    expect(await refusedAsStub(() => withBridge(), 'gcp')).toBe('Google Cloud Platform is not available yet');
    expect(await refusedAsStub(async () => {
      const made = await withBridge();
      await new CredentialService(made.db, KEY).saveCredentials(TEST_USER.id, 'azure', { clientId: 'theirs', clientSecret: 'their-secret' });
      return made;
    }, 'azure')).toBe('Microsoft Azure is not available yet');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'the-servers-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'the-servers-secret');
    expect(await refusedAsStub(() => withBridge(['operator']))).toBe('Amazon Web Services is not available yet');
  });

  it('on a dev box keeps mock cloud mode for a provider with no keys, and refuses it once keys would make it real', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const mocked = await withBridge();
    const started = await axios.post<{ workflowId: string }>(mocked.h.url('/api/clusters'), { name: 'valid-name', provider: 'aws' });
    expect(started.status).toBe(202);
    expect(mocked.start).toHaveBeenCalledTimes(1);
    await settled(mocked, started.data.workflowId);
    await h?.close();
    h = undefined;
    vi.restoreAllMocks();
    expect(await refusedAsStub(async () => {
      const made = await withBridge();
      await new CredentialService(made.db, KEY).saveCredentials(TEST_USER.id, 'aws', { accessKeyId: 'theirs', secretAccessKey: 'their-secret' });
      return made;
    })).toBe('Amazon Web Services is not available yet');
  });

  it('makes a cluster on the providers that are real, DigitalOcean with the plan and region the person chose', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const local = await withBridge();
    const k3d = await axios.post<{ workflowId: string }>(local.h.url('/api/clusters'), { name: 'valid-name', provider: 'k3d' });
    expect(k3d.status).toBe(202);
    await settled(local, k3d.data.workflowId);
    await h?.close();
    h = undefined;
    vi.restoreAllMocks();

    const ocean = await withBridge();
    await new CredentialService(ocean.db, KEY).saveCredentials(TEST_USER.id, 'do', { token: 'their-do-token' });
    const droplet = await axios.post<{ workflowId: string }>(ocean.h.url('/api/clusters'), { name: 'droplet-one', provider: 'do', hetznerServerType: 's-2vcpu-8gb', hetznerLocation: 'fra1' });
    expect(droplet.status).toBe(202);
    expect(ocean.start.mock.calls[0]?.[1]).toMatchObject({ args: [expect.objectContaining({ provider: 'do', doToken: 'their-do-token', doSize: 's-2vcpu-8gb', doRegion: 'fra1' })] });
    await settled(ocean, droplet.data.workflowId);
  });
});
