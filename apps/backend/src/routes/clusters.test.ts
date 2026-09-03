import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { clustersRouter } from './clusters.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

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
    listAllPods: vi.fn(async () => [{ metadata: { name: 'p1' } }]),
    listReleases: vi.fn(async () => [{ name: 'traefik' }]),
    getGpuStatus: vi.fn(async () => ({ gpus: 0 })),
    getKubeconfigPath: vi.fn(async () => '/tmp/kubeconfig'),
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

const mount = async (svc = services(), user: typeof TEST_USER | null = TEST_USER) => {
  h = await mountRouter({
    prefix: '/api/clusters',
    user,
    router: () => clustersRouter({ ...svc, jwtSecret: 'test-secret' } as never),
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
    const err = await axios.get(h.url('/api/clusters/someone-elses/services')).catch((e) => e);
    expect(err.response.status).toBe(404);
    expect(JSON.stringify(err.response.data)).not.toMatch(/permission|forbidden|owner/i);
  });

  it('404s identically for an id that does not exist', async () => {
    const { h, svc } = await mount();
    svc.clusterService.getById.mockResolvedValue(undefined as never);
    const err = await axios.get(h.url('/api/clusters/no-such-thing/services')).catch((e) => e);
    expect(err.response.status).toBe(404);
  });

  it('passes the calling user down to every lookup', async () => {
    const { h, svc } = await mount();
    h.setUser({ id: 'someone-else', email: 'other@example.com', isAdmin: false });
    await axios.get(h.url('/api/clusters/c1/all-pods')).catch(() => undefined);
    expect(svc.clusterService.listAllPods).toHaveBeenCalledWith('c1', 'someone-else');
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

describe('when the cluster cannot be reached', () => {
  it('answers rather than hanging', async () => {
    const { h, svc } = await mount();
    svc.clusterService.listAllPods.mockRejectedValue(new Error('dial tcp: i/o timeout') as never);
    await expect(axios.get(h.url('/api/clusters/c1/all-pods'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500, data: { error: 'dial tcp: i/o timeout' } },
    });
  });
});
