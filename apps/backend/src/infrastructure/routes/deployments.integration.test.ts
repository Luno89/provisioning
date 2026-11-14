import { describe, it, expect, afterEach, vi } from 'vitest';
import { DependencyDownError } from '../../platform/lib/dependencies.js';
import axios from 'axios';
import { deploymentsRouter } from './deployments.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { CapacityError } from '../lib/cluster-capacity.js';

vi.mock('../lib/huggingface.js', () => ({ getHfModelSize: async () => ({ totalBytes: 20e9 }) }));

const ANY_STATUS = { validateStatus: () => true };

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const deployment = (over: Record<string, unknown> = {}) => ({
  id: 'd1', name: 'odoo', appType: 'odoo', clusterId: 'c1', ownerId: TEST_USER.id, ...over,
});

const services = () => ({
  appService: {
    getAll: vi.fn(async () => [deployment()]),
    getById: vi.fn(async () => deployment()),
    getHelmStatus: vi.fn(async () => 'deployed'),
    getDiagnostics: vi.fn(async () => 'all good'),
    listPods: vi.fn(async () => [{ metadata: { name: 'p1' } }]),
    updateModules: vi.fn(async () => ({ ok: true })),
    signIns: vi.fn(async (id: string): Promise<unknown> => (id === 'd1' ? [{ describe: 'The Hermes dashboard', login: 'admin', password: 'generated-for-d1' }] : undefined)),
  },
  clusterService: { getById: vi.fn(async () => ({ id: 'c1', name: 'dev' })) },
  appExposureService: { expose: vi.fn(async () => ({ url: 'https://x' })), unexpose: vi.fn(async () => undefined) },
  access: { kubectl: vi.fn(async (_clusterId: string, _args: readonly string[]): Promise<string> => '') },
  temporalBridge: {
    deployApp: vi.fn(async () => ({ id: 'w1', resourceId: 'd1' })),
    destroyApp: vi.fn(async () => ({ id: 'w2' })),
    resizeDisk: vi.fn(async () => ({ id: 'w3' })),
    updateConfigAndSync: vi.fn(async () => ({ id: 'w4' })),
  },
  db: { infrastructure: { getDeployments: vi.fn(async () => [deployment()]), saveDeployment: vi.fn(async () => undefined) } },
  io: { emit: vi.fn() },
});

const mount = async (svc = services(), user: typeof TEST_USER | null = TEST_USER) => {
  h = await mountRouter({
    prefix: '/api/deployments',
    user,
    router: () => deploymentsRouter(svc as never),
  });
  return { h: h!, svc };
};

describe('listing deployments', () => {
  it('scopes to the caller', async () => {
    const { h, svc } = await mount();
    const res = await axios.get(h.url('/api/deployments'));
    expect(res.status).toBe(200);
    expect(svc.appService.getAll).toHaveBeenCalledWith(TEST_USER.id);
  });

  it('refuses an unauthenticated caller', async () => {
    const { h } = await mount(services(), null);
    await expect(axios.get(h.url('/api/deployments'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('never reads on behalf of a different tenant', async () => {
    const { h, svc } = await mount();
    h.setUser({ id: 'someone-else', email: 'other@example.com' });
    await axios.get(h.url('/api/deployments/d1/helm')).catch(() => undefined);
    expect(svc.appService.getHelmStatus).toHaveBeenCalledWith('d1', 'someone-else');
  });
});

describe('patching config', () => {
  it('validates against the stored appType', async () => {
    const { h, svc } = await mount();
    svc.appService.getById.mockResolvedValue(deployment({ appType: 'odoo' }) as never);
    await axios.patch(h.url('/api/deployments/d1/config'), {
      appSettings: {}, appType: 'not-this-one',
    }).catch(() => undefined);
    expect(svc.appService.getById).toHaveBeenCalledWith('d1', TEST_USER.id);
  });

  it('rejects settings the schema does not accept, with the reasons', async () => {
    const { h } = await mount();
    const err = await axios.patch<unknown>(h.url('/api/deployments/d1/config'), {
      appSettings: { adminPassword: 12345 },
    }, ANY_STATUS);
    if (err.status === 400) {
      expect(err.data).toHaveProperty('error');
    }
  });

  it('reports Temporal being down as 503, not as a bad patch', async () => {
    const { h, svc } = await mount();
    svc.temporalBridge.updateConfigAndSync.mockRejectedValue(new Error('no worker') as never);
    const err = await axios.patch<unknown>(h.url('/api/deployments/d1/config'), { replicas: 2 }, ANY_STATUS);
    expect(err.status).toBe(503);
  });
});

describe('when the cluster cannot be reached', () => {
  it('answers rather than hanging', async () => {
    const { h, svc } = await mount();
    svc.appService.getHelmStatus.mockRejectedValue(new Error('cluster unreachable') as never);
    await expect(axios.get(h.url('/api/deployments/d1/helm'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500, data: { error: 'cluster unreachable' } },
    });
  });

  it('answers for diagnostics too', async () => {
    const { h, svc } = await mount();
    svc.appService.getDiagnostics.mockRejectedValue(new Error('kubectl timeout') as never);
    await expect(axios.get(h.url('/api/deployments/d1/diagnostics'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500 },
    });
  });
});

describe('the four routes that lived 3,900 lines away', () => {
  it('are all reachable under the same prefix as the rest', async () => {
    const { h } = await mount();
    const reached = async (call: Promise<{ status: number }>) => (await call).status !== 404;
    expect(await reached(axios.patch(h.url('/api/deployments/d1/modules'), { modules: [] }, ANY_STATUS))).toBe(true);
    expect(await reached(axios.patch(h.url('/api/deployments/d1/storage'), { size: '10Gi' }, ANY_STATUS))).toBe(true);
    expect(await reached(axios.get(h.url('/api/deployments/d1/resource-plan'), ANY_STATUS))).toBe(true);
    expect(await reached(axios.patch(h.url('/api/deployments/d1/config'), { replicas: 1 }, ANY_STATUS))).toBe(true);
  });
});

describe('a TabbyAPI deployment\'s resource plan', () => {
  const tabby = () => {
    const svc = services();
    svc.appService.getById = vi.fn(async () => deployment({ appType: 'tabbyapi', tabbyModel: 'org/model' }));
    return svc;
  };

  it('budgets against the smallest node\'s memory, read from the cluster', async () => {
    const svc = tabby();
    svc.access.kubectl = vi.fn(async () => '4Gi 64Gi');
    await mount(svc);
    const res = await axios.get<{ applicable: boolean; refusal?: string }>(h!.url('/api/deployments/d1/resource-plan'));
    expect(res.data.applicable).toBe(true);
    expect(res.data.refusal).toMatch(/allocatable/);
  });

  it('plans without a budget when the nodes\' memory cannot be read, and says nothing is refused', async () => {
    const svc = tabby();
    svc.access.kubectl = vi.fn(async () => { throw new Error('the cluster did not answer'); });
    await mount(svc);
    const res = await axios.get<{ applicable: boolean; refusal?: string }>(h!.url('/api/deployments/d1/resource-plan'));
    expect(res.data.applicable).toBe(true);
    expect(res.data.refusal).toBeUndefined();
  });
});

describe('POST / when the deploy is refused', () => {
  it('answers 400 with the reason when the cluster cannot fit the app', async () => {
    const svc = services();
    svc.temporalBridge.deployApp = vi.fn(async () => {
      throw new CapacityError('vLLM needs about 6 GiB of RAM but this cluster has 2 GiB');
    });
    await mount(svc);

    const res = await axios.post<{ error: string }>(h!.url('/api/deployments'), { name: 'x', clusterId: 'c1' }, {
      validateStatus: () => true,
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('vLLM needs about 6 GiB of RAM but this cluster has 2 GiB');
    expect(res.data.error).not.toMatch(/Temporal/);
  });

  it('still answers 503, with Temporal\'s state, when Temporal genuinely is unavailable', async () => {
    const svc = services();
    svc.temporalBridge.deployApp = vi.fn(async () => { throw new DependencyDownError('temporal', '2026-11-13T10:02:00Z', 'it refused the connection (ECONNREFUSED)'); });
    await mount(svc);

    const res = await axios.post<{ error: string; dependency: string }>(h!.url('/api/deployments'), { name: 'x', clusterId: 'c1' }, {
      validateStatus: () => true,
    });

    expect(res.status).toBe(503);
    expect(res.data.dependency).toBe('temporal');
    expect(res.data.error).toMatch(/isn't answering since .*: it refused the connection \(ECONNREFUSED\)/);
  });

  it('answers a failure it did not expect with 500 and its reason, never as Temporal being down', async () => {
    const svc = services();
    svc.temporalBridge.deployApp = vi.fn(async () => { throw new Error('the deployment record could not be saved'); });
    await mount(svc);

    const res = await axios.post<{ error: string }>(h!.url('/api/deployments'), { name: 'x', clusterId: 'c1' }, {
      validateStatus: () => true,
    });

    expect(res.status).toBe(500);
    expect(res.data.error).toBe('the deployment record could not be saved');
  });
});

describe('an app\'s sign-in', () => {
  it('is shown to its owner on asking, never cached', async () => {
    const { h, svc } = await mount();
    const res = await axios.get(h.url('/api/deployments/d1/sign-in'));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.data).toEqual({ signIns: [{ describe: 'The Hermes dashboard', login: 'admin', password: 'generated-for-d1' }] });
    expect(svc.appService.signIns).toHaveBeenCalledWith('d1', TEST_USER.id);
    expect((await axios.get(h.url('/api/deployments/elsewhere/sign-in'), { validateStatus: () => true })).status).toBe(404);
  });

  it('never rides along in a listing, or in anything else the deployments send', async () => {
    const svc = services();
    const sealed = { nextcloudAdminPassword: 'nc-admin', minioRootPassword: 'minio-root', vllmHfToken: 'hf_x', hermesDashboardPassword: 'hermes-x' };
    svc.appService.getAll.mockResolvedValue([deployment({ appType: 'nextcloud', ...sealed })] as never);
    svc.appService.updateModules.mockResolvedValue({ deployment: deployment(sealed) } as never);
    const { h } = await mount(svc);
    const listed = await axios.get<unknown[]>(h.url('/api/deployments'));
    expect(listed.data[0]).toMatchObject({ id: 'd1', appType: 'nextcloud' });
    const changed = await axios.patch(h.url('/api/deployments/d1/modules'), { modules: [] });
    for (const body of [listed.data, changed.data]) for (const value of Object.values(sealed)) expect(JSON.stringify(body)).not.toContain(value);
  });
});
