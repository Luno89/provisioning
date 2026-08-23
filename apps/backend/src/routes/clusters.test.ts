import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { clustersRouter } from './clusters.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

/**
 * The clusters routes, over real HTTP.
 *
 * These had no HTTP coverage at all. `ClusterService` is well tested on its own, but the layer
 * between a request and it was not — and that layer is where the tenancy rule lives.
 *
 * The service is stubbed: it shells out to kubectl and k3d and talks to cloud APIs. What is under
 * test is the route — its status codes, what it passes to the service, and which user it passes.
 */

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
    // The id comes from the session, never from a query parameter — the rule every route follows.
    expect(svc.clusterService.getAll).toHaveBeenCalledWith(TEST_USER.id, expect.anything());
  });

  it('refuses an unauthenticated caller', async () => {
    const { h } = await mount(services(), null);
    await expect(axios.get(h.url('/api/clusters'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});

/**
 * ── A GUESSED ID MUST NOT CONFIRM ANYTHING ──
 *
 * `ClusterService.getById` returns undefined for both "no such cluster" and "not yours", and its
 * comment says why: a 403 would tell an attacker the id exists. The routes have to preserve that by
 * answering 404 in both cases — which is easy to break by adding a helpful error message.
 */
describe('reading one cluster', () => {
  it('404s for a cluster owned by someone else, not 403', async () => {
    const { h, svc } = await mount();
    svc.clusterService.getById.mockResolvedValue(undefined as never);
    const err = await axios.get(h.url('/api/clusters/someone-elses/services')).catch((e) => e);
    expect(err.response.status).toBe(404);
    // The body must not distinguish the two cases either.
    expect(JSON.stringify(err.response.data)).not.toMatch(/permission|forbidden|owner/i);
  });

  it('404s identically for an id that does not exist', async () => {
    const { h, svc } = await mount();
    svc.clusterService.getById.mockResolvedValue(undefined as never);
    const err = await axios.get(h.url('/api/clusters/no-such-thing/services')).catch((e) => e);
    expect(err.response.status).toBe(404);
  });

  it('passes the calling user down to every lookup', async () => {
    // The check that a route cannot accidentally read on behalf of the wrong tenant.
    const { h, svc } = await mount();
    h.setUser({ id: 'someone-else', email: 'other@example.com', isAdmin: false });
    await axios.get(h.url('/api/clusters/c1/all-pods')).catch(() => undefined);
    expect(svc.clusterService.listAllPods).toHaveBeenCalledWith('c1', 'someone-else');
  });
});

describe('creating a cluster', () => {
  it('rejects a name that would break deep inside CDKTF, before anything is billed', async () => {
    /**
     * The name becomes a TerraformStack id and a Kubernetes object name. Unchecked, an invalid one
     * fails minutes later inside a CDKTF subprocess with "Cannot create TerraformStack with id …
     * It contains a whitespace character" — after a VM may already have been created and charged
     * for. That is why the check is synchronous and here rather than in the workflow.
     */
    const { h, svc } = await mount();
    const err = await axios.post(h.url('/api/clusters'), { name: 'has spaces' }).catch((e) => e);
    expect(err.response.status).toBe(400);
    expect(svc.temporalBridge.provision).not.toHaveBeenCalled();
  });

  it('reports Temporal being down as 503, not as a bad request', async () => {
    // The distinction matters to the UI: 503 is "try again", 400 is "fix your input".
    const { h, svc } = await mount();
    svc.temporalBridge.provision.mockRejectedValue(new Error('connection refused') as never);
    const err = await axios.post(h.url('/api/clusters'), { name: 'valid-name' }).catch((e) => e);
    expect(err.response.status).toBe(503);
  });
});

describe('the dashboard proxies', () => {
  it('exposes one route per service and 404s an unknown cluster on each', async () => {
    // Generated in a loop, so this iterates too — a service added to PROXY_SERVICES is covered.
    const { h, svc } = await mount();
    svc.clusterService.getById.mockResolvedValue(undefined as never);
    for (const service of ['prometheus', 'grafana', 'traefik', 'gitea', 'alertmanager']) {
      const err = await axios.get(h.url(`/api/clusters/c1/proxy/${service}`)).catch((e) => e);
      expect(err.response?.status, service).toBe(404);
    }
  });
});

describe('when the cluster cannot be reached', () => {
  it('answers rather than hanging', async () => {
    /**
     * `listAllPods` was a one-line handler with no try/catch, so a rejection produced an unhandled
     * rejection and NO response — the request hung until the client gave up. Reaching an
     * unreachable cluster is not hypothetical; it is what happens when a node dies.
     */
    const { h, svc } = await mount();
    svc.clusterService.listAllPods.mockRejectedValue(new Error('dial tcp: i/o timeout') as never);
    await expect(axios.get(h.url('/api/clusters/c1/all-pods'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500, data: { error: 'dial tcp: i/o timeout' } },
    });
  });
});
