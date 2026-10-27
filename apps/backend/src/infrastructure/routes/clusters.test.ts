import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { clustersRouter } from './clusters.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { clusterOwnership } from '../../platform/lib/ownership.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const cluster = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'dev', ownerId: TEST_USER.id, status: 'running', ...over,
});

const services = () => ({
  clusterService: {
    getAll: vi.fn(async () => [cluster()]),
    getById: vi.fn(async (id: string, userId: string) =>
      (id === 'c1' && userId === TEST_USER.id ? cluster() : undefined)),
    getGpuStatus: vi.fn(async () => ({ gpus: 0 })),
    getKubeconfigPath: vi.fn(async () => '/tmp/kubeconfig'),
    discoverClusters: vi.fn(async () => []),
  },
  appService: { discoverDeployments: vi.fn(async () => []) },
  clusterProxyService: {
    ensurePortForward: vi.fn(async () => 'http://127.0.0.1:9999'),
    stopForCluster: vi.fn(),
    getAutoLoginCookies: vi.fn(async () => []),
  },
  infraService: { runKubectl: vi.fn(async () => '') },
  temporalBridge: { provision: vi.fn(async () => ({ workflowId: 'w1' })), destroy: vi.fn(async () => undefined) },
  db: { getClusters: vi.fn(async () => [cluster()]), saveClusterList: vi.fn(async () => undefined) },
  giteaService: {},
  io: { emit: vi.fn() },
});

const mount = async (svc = services(), user: typeof TEST_USER | null = TEST_USER, instanceOwner?: string) => {
  h = await mountRouter({
    prefix: '/api/clusters',
    user,
    router: () => clustersRouter({ ...svc, dataKey: 'test-secret', ownsCluster: clusterOwnership(instanceOwner) } as never),
  });
  return { h: h!, svc };
};

describe('listing clusters', () => {
  it('returns only what the caller owns, scoped by the session', async () => {
    const { h, svc } = await mount();
    const res = await axios.get(h.url('/api/clusters'));
    expect(res.status).toBe(200);
    expect(svc.clusterService.getAll).toHaveBeenCalledWith(TEST_USER.id, expect.anything());
  });

  it('refuses an unauthenticated caller', async () => {
    const { h } = await mount(services(), null);
    await expect(axios.get(h.url('/api/clusters'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});

describe('reading one cluster', () => {
  it('404s for a cluster owned by someone else, not 403', async () => {
    const { h, svc } = await mount();
    svc.clusterService.getById.mockResolvedValue(undefined as never);
    const err = await axios.get(h.url('/api/clusters/someone-elses/proxy/grafana')).catch((e) => e);
    expect(err.response.status).toBe(404);
    expect(JSON.stringify(err.response.data)).not.toMatch(/permission|forbidden|owner/i);
  });

  it('404s identically for an id that does not exist', async () => {
    const { h, svc } = await mount();
    svc.clusterService.getById.mockResolvedValue(undefined as never);
    const err = await axios.get(h.url('/api/clusters/no-such-thing/proxy/grafana')).catch((e) => e);
    expect(err.response.status).toBe(404);
  });

  it('passes the calling user down to every lookup', async () => {
    const { h, svc } = await mount();
    h.setUser({ id: 'someone-else', email: 'other@example.com', isAdmin: false });
    await axios.get(h.url('/api/clusters/c1/gpu-status')).catch(() => undefined);
    expect(svc.clusterService.getById).toHaveBeenCalledWith('c1', 'someone-else');
  });
});

describe('creating a cluster', () => {
  it('rejects a name that would break deep inside CDKTF, before anything is billed', async () => {
    const { h, svc } = await mount();
    const err = await axios.post(h.url('/api/clusters'), { name: 'has spaces' }).catch((e) => e);
    expect(err.response.status).toBe(400);
    expect(svc.temporalBridge.provision).not.toHaveBeenCalled();
  });

  it('reports Temporal being down as 503, not as a bad request', async () => {
    const { h, svc } = await mount();
    svc.temporalBridge.provision.mockRejectedValue(new Error('connection refused') as never);
    const err = await axios.post(h.url('/api/clusters'), { name: 'valid-name' }).catch((e) => e);
    expect(err.response.status).toBe(503);
  });
});

describe('the dashboard proxies', () => {
  it('exposes one route per service and 404s an unknown cluster on each', async () => {
    const { h, svc } = await mount();
    svc.clusterService.getById.mockResolvedValue(undefined as never);
    for (const service of ['prometheus', 'grafana', 'traefik', 'gitea', 'alertmanager', 'infisical']) {
      const err = await axios.get(h.url(`/api/clusters/c1/proxy/${service}`)).catch((e) => e);
      expect(err.response?.status, service).toBe(404);
    }
  });
});

describe('what only whoever owns a cluster may open', () => {
  const PROXIES = ['prometheus', 'grafana', 'traefik', 'gitea', 'alertmanager', 'infisical'];
  const system = cluster({ id: 'provisioning-lunorica', isSystem: true, ownerId: undefined });
  const onSystem = () => {
    const svc = services();
    svc.clusterService.getById.mockImplementation(async (id: string) => (id === system.id ? system : undefined) as never);
    return svc;
  };
  const someone = { id: 'someone', email: 'someone@example.com', isAdmin: false };
  const admin = { id: 'an-admin', email: 'admin@example.com', isAdmin: true };

  it('answers someone who only sees the system cluster exactly as for an unknown one, and opens nothing', async () => {
    const { h, svc } = await mount(onSystem(), someone);
    for (const service of PROXIES) {
      const err = await axios.get(h.url(`/api/clusters/${system.id}/proxy/${service}`), { maxRedirects: 0 }).catch((e) => e);
      expect(err.response?.status, service).toBe(404);
      expect(err.response?.data, service).toEqual({ error: 'Cluster not found' });
    }
    const gpu = await axios.get(h.url(`/api/clusters/${system.id}/gpu-status`)).catch((e) => e);
    expect(gpu.response?.status).toBe(404);
    expect(gpu.response?.data).toEqual({ error: 'Cluster not found' });
    expect(svc.clusterProxyService.ensurePortForward).not.toHaveBeenCalled();
    expect(svc.clusterProxyService.getAutoLoginCookies).not.toHaveBeenCalled();
    expect(svc.infraService.runKubectl).not.toHaveBeenCalled();
    expect(svc.clusterService.getGpuStatus).not.toHaveBeenCalled();
  });

  it('on an instance, refuses an admin who is not its owner', async () => {
    const { h, svc } = await mount(onSystem(), admin, 'the-owner');
    const err = await axios.get(h.url(`/api/clusters/${system.id}/proxy/grafana`), { maxRedirects: 0 }).catch((e) => e);
    expect(err.response?.status).toBe(404);
    expect(svc.clusterProxyService.ensurePortForward).not.toHaveBeenCalled();
  });

  it('opens the system cluster\'s dashboards and GPUs for an admin when combined, and for the owner on an instance', async () => {
    for (const [user, instanceOwner] of [[admin, undefined], [someone, 'someone']] as const) {
      const { h, svc } = await mount(onSystem(), user, instanceOwner);
      const res = await axios.get(h.url(`/api/clusters/${system.id}/proxy/grafana`), { maxRedirects: 0 }).catch((e) => e);
      expect(res.response?.status).toBe(302);
      expect(svc.clusterProxyService.getAutoLoginCookies).toHaveBeenCalled();
      expect((await axios.get(h.url(`/api/clusters/${system.id}/gpu-status`))).data).toEqual({ gpus: 0 });
      await h.close();
    }
    h = undefined;
  });

  it('opens a cluster of the caller\'s own', async () => {
    const { h, svc } = await mount();
    const res = await axios.get(h.url('/api/clusters/c1/proxy/prometheus'));
    expect(res.status).toBe(200);
    expect(svc.clusterProxyService.ensurePortForward).toHaveBeenCalledWith('c1', 'prometheus', '/tmp/kubeconfig');
    expect((await axios.get(h.url('/api/clusters/c1/gpu-status'))).data).toEqual({ gpus: 0 });
  });
});

describe('when the cluster cannot be reached', () => {
  it('answers rather than hanging', async () => {
    const { h, svc } = await mount();
    svc.clusterService.getGpuStatus.mockRejectedValue(new Error('dial tcp: i/o timeout') as never);
    await expect(axios.get(h.url('/api/clusters/c1/gpu-status'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500, data: { error: 'dial tcp: i/o timeout' } },
    });
  });
});

describe('adopting the clusters left on the host', () => {
  it('is an admin\'s to do', async () => {
    const { h, svc } = await mount();
    expect((await axios.post(h.url('/api/clusters/discover'), {}, { validateStatus: () => true })).status).toBe(403);
    expect(svc.clusterService.discoverClusters).not.toHaveBeenCalled();
    await h.close();
    const admin = await mount(services(), { ...TEST_USER, isAdmin: true } as typeof TEST_USER);
    expect((await axios.post(admin.h.url('/api/clusters/discover'), {})).status).toBe(200);
    expect(admin.svc.clusterService.discoverClusters).toHaveBeenCalledWith(TEST_USER.id);
  });
});
