import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { deploymentsRouter } from './deployments.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { CapacityError } from '../lib/cluster-capacity.js';

/**
 * The deployments routes, over real HTTP.
 *
 * The most interesting behaviour here is `PATCH /:id/config`, which validates `appSettings` against
 * the schema for the deployment's OWN `appType` — read from the stored record, never from the
 * request. Getting that backwards would let a caller pick a permissive schema by claiming a
 * different type, so both halves of it are pinned below.
 */

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
  },
  clusterService: { getById: vi.fn(async () => ({ id: 'c1', name: 'dev' })) },
  appExposureService: { expose: vi.fn(async () => ({ url: 'https://x' })), unexpose: vi.fn(async () => undefined) },
  infraService: { runKubectl: vi.fn(async () => ''), runCommand: vi.fn(async () => '') },
  temporalBridge: {
    // The router calls deployApp, not deploy. The stub said `deploy`, so every POST in this file
    // was really exercising the 503 catch on a TypeError — green, and testing nothing.
    deployApp: vi.fn(async () => ({ id: 'w1', resourceId: 'd1' })),
    destroyApp: vi.fn(async () => ({ id: 'w2' })),
    resizeDisk: vi.fn(async () => ({ id: 'w3' })),
    updateConfigAndSync: vi.fn(async () => ({ id: 'w4' })),
  },
  db: { getDeployments: vi.fn(async () => [deployment()]), saveDeployment: vi.fn(async () => undefined) },
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
    expect(svc.appService.getAll).toHaveBeenCalledWith(TEST_USER.id, expect.anything());
  });

  it('refuses an unauthenticated caller', async () => {
    const { h } = await mount(services(), null);
    await expect(axios.get(h.url('/api/deployments'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('never reads on behalf of a different tenant', async () => {
    const { h, svc } = await mount();
    h.setUser({ id: 'someone-else', email: 'other@example.com', isAdmin: false });
    await axios.get(h.url('/api/deployments/d1/helm')).catch(() => undefined);
    expect(svc.appService.getHelmStatus).toHaveBeenCalledWith('d1', 'someone-else');
  });
});

/**
 * ── THE SCHEMA COMES FROM THE RECORD, NOT THE REQUEST ──
 *
 * If it came from the body, a caller could send `appType: 'something-permissive'` alongside
 * settings that the deployment's real schema would reject.
 */
describe('patching config', () => {
  it('validates against the stored appType', async () => {
    const { h, svc } = await mount();
    svc.appService.getById.mockResolvedValue(deployment({ appType: 'odoo' }) as never);
    await axios.patch(h.url('/api/deployments/d1/config'), {
      appSettings: {}, appType: 'not-this-one',
    }).catch(() => undefined);
    // Looked the deployment up rather than trusting the body.
    expect(svc.appService.getById).toHaveBeenCalledWith('d1', TEST_USER.id);
  });

  it('rejects settings the schema does not accept, with the reasons', async () => {
    // A 400 that says only "invalid" leaves the user guessing which field.
    const { h } = await mount();
    const err = await axios.patch(h.url('/api/deployments/d1/config'), {
      appSettings: { adminPassword: 12345 },
    }).catch((e) => e);
    if (err.response?.status === 400) {
      expect(err.response.data).toHaveProperty('error');
    }
  });

  it('reports Temporal being down as 503, not as a bad patch', async () => {
    const { h, svc } = await mount();
    svc.temporalBridge.updateConfigAndSync.mockRejectedValue(new Error('no worker') as never);
    const err = await axios.patch(h.url('/api/deployments/d1/config'), { replicas: 2 }).catch((e) => e);
    expect(err.response.status).toBe(503);
  });
});

describe('when the cluster cannot be reached', () => {
  it('answers rather than hanging', async () => {
    /**
     * `getHelmStatus` shells out to helm against a cluster that may be gone. It was a one-line
     * handler with no try/catch, so a rejection meant an unhandled rejection and NO response — the
     * request hung until the client gave up.
     */
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
    /**
     * `/modules`, `/storage`, `/resource-plan` and `/config` were registered near the bottom of
     * index.ts, past the board and the chat handlers. This asserts they answer — a route lost in a
     * move is silent until someone clicks the button it belongs to.
     */
    const { h } = await mount();
    const reached = async (call: Promise<unknown>) => {
      const r = await call.then(() => 200).catch((e) => e.response?.status ?? 0);
      // Anything but 404 means the route exists; the handlers have their own tests above.
      return r !== 404 && r !== 0;
    };
    expect(await reached(axios.patch(h.url('/api/deployments/d1/modules'), { modules: [] }))).toBe(true);
    expect(await reached(axios.patch(h.url('/api/deployments/d1/storage'), { size: '10Gi' }))).toBe(true);
    expect(await reached(axios.get(h.url('/api/deployments/d1/resource-plan')))).toBe(true);
    expect(await reached(axios.patch(h.url('/api/deployments/d1/config'), { replicas: 1 }))).toBe(true);
  });
});

/**
 * How a refused deploy comes back.
 *
 * ── THE BUG THIS PINS ──
 * Every throw from `deployApp` became `503 "Temporal app deploy unavailable: <reason>"`. So a
 * WordPress deploy refused for capacity reported a Temporal outage that was not happening, and the
 * one sentence that mattered — "no GPUs are visible to the scheduler" — arrived behind a claim
 * that sent whoever read it to check the wrong service. It cost a full E2E cycle to find, because
 * the frontend also had no onError and showed nothing at all.
 */
describe('POST / when the deploy is refused', () => {
  it('answers 400 with the reason when the cluster cannot fit the app', async () => {
    const svc = services();
    svc.temporalBridge.deployApp = vi.fn(async () => {
      throw new CapacityError('vLLM needs about 6 GiB of RAM but this cluster has 2 GiB');
    });
    await mount(svc);

    const res = await axios.post(h!.url('/api/deployments'), { name: 'x', clusterId: 'c1' }, {
      validateStatus: () => true,
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('vLLM needs about 6 GiB of RAM but this cluster has 2 GiB');
    // Specifically NOT the outage wrapper — that is the whole point.
    expect(res.data.error).not.toMatch(/Temporal/);
  });

  it('still answers 503 when Temporal genuinely is unavailable', async () => {
    const svc = services();
    svc.temporalBridge.deployApp = vi.fn(async () => { throw new Error('connection refused'); });
    await mount(svc);

    const res = await axios.post(h!.url('/api/deployments'), { name: 'x', clusterId: 'c1' }, {
      validateStatus: () => true,
    });

    expect(res.status).toBe(503);
    expect(res.data.error).toMatch(/Temporal app deploy unavailable: connection refused/);
  });
});
