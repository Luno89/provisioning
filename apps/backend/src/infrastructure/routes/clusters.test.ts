import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { clustersRouter } from './clusters.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { allowed, clusterResource, type Principal } from '../../platform/lib/permissions.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { TemporalBridge } from '../services/TemporalBridge.js';
import { CredentialService } from '../services/CredentialService.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const cluster = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'dev', ownerId: TEST_USER.id, status: 'running', ...over,
});

const services = () => ({
  clusterService: {
    getAll: vi.fn(async () => [cluster()]),
    getById: vi.fn(async (id: string, principal: Principal, action: 'see' | 'see-everything' | 'change' | 'delete' | 'deploy-to' = 'see') => {
      const found = id === 'c1' ? cluster() : undefined;
      return found && allowed(principal, action, clusterResource(found)) ? found : undefined;
    }),
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
    claims: instanceOwner ? { role: 'instance', instanceOwnerId: instanceOwner } : { role: 'combined' },
    router: () => clustersRouter({ ...svc, dataKey: 'test-secret' } as never),
  });
  return { h: h!, svc };
};

describe('listing clusters', () => {
  it('returns only what the caller owns, scoped by the session', async () => {
    const { h, svc } = await mount();
    const res = await axios.get(h.url('/api/clusters'));
    expect(res.status).toBe(200);
    expect(svc.clusterService.getAll).toHaveBeenCalledWith(expect.objectContaining({ id: TEST_USER.id }), expect.anything());
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
    h.setUser({ id: 'someone-else', email: 'other@example.com' });
    await axios.get(h.url('/api/clusters/c1/gpu-status')).catch(() => undefined);
    expect(svc.clusterService.getById).toHaveBeenCalledWith('c1', expect.objectContaining({ id: 'someone-else' }), 'see-everything');
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
    svc.clusterService.getById.mockImplementation(async (id: string, principal: Principal, action = 'see') => (id === system.id && allowed(principal, action, clusterResource(system)) ? system : undefined) as never);
    return svc;
  };
  const someone = { id: 'someone', email: 'someone@example.com' };
  const admin = { id: 'an-admin', email: 'admin@example.com', roles: ['operator' as const] };

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

  it('lets only the operator make records of the system cluster\'s apps, and nobody delete it', async () => {
    const { h, svc } = await mount(onSystem(), someone);
    const discover = await axios.post(h.url(`/api/clusters/${system.id}/discover-deployments`)).catch((e) => e);
    expect([discover.response?.status, discover.response?.data]).toEqual([404, { error: 'Cluster not found' }]);
    expect(svc.appService.discoverDeployments).not.toHaveBeenCalled();
    const deleted = await axios.delete(h.url(`/api/clusters/${system.id}`)).catch((e) => e);
    expect([deleted.response?.status, deleted.response?.data]).toEqual([403, { error: 'The system cluster cannot be deleted' }]);
    await h.close();
    const asOperator = await mount(onSystem(), admin);
    expect((await axios.post(asOperator.h.url(`/api/clusters/${system.id}/discover-deployments`))).status).toBe(200);
    const operatorDeletes = await axios.delete(asOperator.h.url(`/api/clusters/${system.id}`)).catch((e) => e);
    expect(operatorDeletes.response?.status).toBe(403);
  });

  it('lets only the operator adopt the host\'s clusters', async () => {
    const { h, svc } = await mount(services(), someone);
    const refused = await axios.post(h.url('/api/clusters/discover')).catch((e) => e);
    expect([refused.response?.status, refused.response?.data]).toEqual([403, { error: 'Only the operator of this server can do that.' }]);
    expect(svc.clusterService.discoverClusters).not.toHaveBeenCalled();
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
    const admin = await mount(services(), { ...TEST_USER, roles: ['operator' as const] } as typeof TEST_USER);
    expect((await axios.post(admin.h.url('/api/clusters/discover'), {})).status).toBe(200);
    expect(admin.svc.clusterService.discoverClusters).toHaveBeenCalledWith(TEST_USER.id);
  });
});

describe('which providers Koala makes a cluster on', () => {
  const KEY = 'test-secret';

  async function withBridge(roles: ('operator')[] = []) {
    const db = await testDatabase();
    await db.accounts.saveUser({ id: TEST_USER.id, email: TEST_USER.email, twoFactorEnabled: false, emailVerified: true, createdAt: 'then', roles } as never);
    const bridge = new TemporalBridge(db, undefined, KEY);
    const start = vi.fn(async (..._args: unknown[]) => undefined);
    bridge.client = { workflow: { start } } as never;
    vi.spyOn(bridge, 'trackWorkflow').mockImplementation(() => undefined as never);
    const mounted = await mount({ ...services(), temporalBridge: bridge } as never, { ...TEST_USER, roles });
    return { ...mounted, db, start };
  }

  const refusedAsStub = async (setup: () => Promise<{ h: Harness; db: Awaited<ReturnType<typeof testDatabase>>; start: ReturnType<typeof vi.fn> }>, provider = 'aws') => {
    const { h: harness, db, start } = await setup();
    const err = await axios.post(harness.url('/api/clusters'), { name: 'valid-name', provider }).catch((e) => e);
    expect(err.response.status).toBe(400);
    expect(await db.infrastructure.getClusters()).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    await h?.close();
    h = undefined;
    return err.response.data.error as string;
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
    expect((await axios.post(mocked.h.url('/api/clusters'), { name: 'valid-name', provider: 'aws' })).status).toBe(202);
    expect(mocked.start).toHaveBeenCalledTimes(1);
    await h?.close();
    h = undefined;
    expect(await refusedAsStub(async () => {
      const made = await withBridge();
      await new CredentialService(made.db, KEY).saveCredentials(TEST_USER.id, 'aws', { accessKeyId: 'theirs', secretAccessKey: 'their-secret' });
      return made;
    })).toBe('Amazon Web Services is not available yet');
  });

  it('makes a cluster on the providers that are real, DigitalOcean with the plan and region the person chose', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const local = await withBridge();
    expect((await axios.post(local.h.url('/api/clusters'), { name: 'valid-name', provider: 'k3d' })).status).toBe(202);
    await h?.close();
    h = undefined;

    const ocean = await withBridge();
    await new CredentialService(ocean.db, KEY).saveCredentials(TEST_USER.id, 'do', { token: 'their-do-token' });
    expect((await axios.post(ocean.h.url('/api/clusters'), { name: 'droplet-one', provider: 'do', hetznerServerType: 's-2vcpu-8gb', hetznerLocation: 'fra1' })).status).toBe(202);
    expect(ocean.start.mock.calls[0]?.[1]).toMatchObject({ args: [expect.objectContaining({ provider: 'do', doToken: 'their-do-token', doSize: 's-2vcpu-8gb', doRegion: 'fra1' })] });
  });
});
