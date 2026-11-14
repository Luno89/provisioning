import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { matches, mock } from 'vitest-mock-extended';
import type { Server as SocketServer } from 'socket.io';
import type { ClusterMetadata, DeploymentMetadata, Principal } from '../../platform/index.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { CapacityError } from '../lib/cluster-capacity.js';
import { DeployRequestProblem } from '../lib/deploy-request.js';
import { DependencyDownError } from '../../platform/lib/dependencies.js';
import { UnreadableCredential } from '../services/CredentialService.js';
import type { AppExposureService } from '../services/AppExposureService.js';
import type { AppService } from '../services/AppService.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { TemporalBridge, WorkflowDeal } from '../services/TemporalBridge.js';
import { deploymentsRouter } from './deployments.js';
import type { HarnessUser } from '../../platform/routes/test-harness.js';
import { PERSON, routesInProcess, type RouteAnswer } from '../../platform/testing/routes.js';

const server = interceptHttp();

const deployment = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({ id: 'd1', name: 'odoo', appType: 'odoo', clusterId: 'c1', ownerId: PERSON.id, strategy: 'helm', status: 'running', ...over });
const deal = (id: string): WorkflowDeal => ({ id, event: 'x' });

function setup() {
  const appService = mock<AppService>();
  const clusterService = mock<Pick<ClusterService, 'getById'>>();
  const appExposureService = mock<AppExposureService>();
  const temporalBridge = mock<TemporalBridge>();
  const db = memoryDatabase();
  const router = deploymentsRouter({ appService, clusterService, appExposureService, temporalBridge, db, io: mock<SocketServer>() });
  appService.getById.calledWith('d1', PERSON.id).mockResolvedValue(deployment());
  const call = (path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown, user?: HarnessUser): Promise<RouteAnswer> =>
    routesInProcess({ prefix: '/api/deployments', router: () => router, user: PERSON }).then((routes) => routes.request(method, `/api/deployments${path}`, { ...(body !== undefined ? { body } : {}), ...(user ? { user } : {}) }));
  return { appService, clusterService, appExposureService, temporalBridge, db, call };
}

describe('listing deployments', () => {
  it('scopes to the caller', async () => {
    const { appService, call } = setup();
    appService.getAll.calledWith(PERSON.id).mockResolvedValue([{ ...deployment(), listing: { checked: true, onCluster: true } }]);
    expect((await call('')).data).toEqual([{ ...deployment(), listing: { checked: true, onCluster: true } }]);
  });

  it('never rides a sealed field along in a listing or anything else it sends', async () => {
    const { appService, call } = setup();
    const sealed = { nextcloudAdminPassword: 'nc-admin', minioRootPassword: 'minio-root', vllmHfToken: 'hf_x', hermesDashboardPassword: 'hermes-x' };
    appService.getAll.mockResolvedValue([{ ...deployment({ appType: 'nextcloud' }), ...sealed, listing: { checked: true, onCluster: true } }]);
    appService.updateModules.mockResolvedValue({ deployment: { ...deployment(), ...sealed } } as never);
    const listed = await call('');
    const changed = await call('/d1/modules', 'PATCH', { modules: [] });
    expect(listed.data).toMatchObject([{ id: 'd1', appType: 'nextcloud' }]);
    for (const body of [listed.data, changed.data]) for (const value of Object.values(sealed)) expect(JSON.stringify(body)).not.toContain(value);
  });

  it('lists what is deployable, built-ins and the person\'s own', async () => {
    const { db, call } = setup();
    await db.infrastructure.saveAppSpec({ id: 'mine', name: 'mine', ownerId: PERSON.id, spec: { image: 'x' } } as never);
    await db.infrastructure.saveAppSpec({ id: 'theirs', name: 'theirs', ownerId: 'someone-else', spec: { image: 'y' } } as never);
    const ids = ((await call('/catalogue')).data as { id: string; deploysFromSpec: boolean }[]);
    expect(ids.map((spec) => spec.id)).toContain('mine');
    expect(ids.map((spec) => spec.id)).not.toContain('theirs');
    expect(ids.find((spec) => spec.id === 'mine')?.deploysFromSpec).toBe(true);
  });
});

describe('deploying', () => {
  const asked = { name: 'shop', clusterId: 'c1', appType: 'nextcloud' };

  it('starts the deploy on a cluster the person may deploy to and answers 202 with its workflow', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.calledWith('c1', matches<Principal>((who) => who.id === PERSON.id), 'deploy-to').mockResolvedValue({ id: 'c1' } as ClusterMetadata);
    temporalBridge.deployApp.calledWith(matches<Record<string, unknown>>((request) => request.name === 'shop'), PERSON.id).mockResolvedValue({ id: 'w1', resourceId: 'd9', event: 'app-deploy' });
    const answer = await call('', 'POST', asked);
    expect(answer.status).toBe(202);
    expect(answer.data).toEqual({ message: 'Deployment started', deploymentName: 'shop', id: 'd9', workflowId: 'w1', state: 'running' });
  });

  it('refuses a request that names a project\'s app or a namespace it should not', async () => {
    const { call, temporalBridge } = setup();
    const answer = await call('', 'POST', { ...asked, appType: 'gitapp' });
    expect(answer.status).toBe(400);
    expect(temporalBridge.deployApp).not.toHaveBeenCalled();
  });

  it('says the cluster is not found when the person may not deploy to it', async () => {
    const { call } = setup();
    const answer = await call('', 'POST', asked);
    expect(answer.status).toBe(404);
    expect(answer.data).toEqual({ error: 'Cluster not found' });
  });

  it('answers 400 with the reason when the cluster cannot fit the app', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue({ id: 'c1' } as ClusterMetadata);
    temporalBridge.deployApp.mockRejectedValue(new CapacityError('vLLM needs about 6 GiB of RAM but this cluster has 2 GiB'));
    const answer = await call('', 'POST', asked);
    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ error: 'vLLM needs about 6 GiB of RAM but this cluster has 2 GiB' });
  });

  it('answers 400 with the reason when the request itself is refused', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue({ id: 'c1' } as ClusterMetadata);
    temporalBridge.deployApp.mockRejectedValue(new DeployRequestProblem('a model server takes no pgTag: its GPUs, vendor, Hugging Face token and image each have their own field'));
    const answer = await call('', 'POST', asked);
    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ error: 'a model server takes no pgTag: its GPUs, vendor, Hugging Face token and image each have their own field' });
  });

  it('answers 503 with Temporal\'s state only when Temporal is not answering', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue({ id: 'c1' } as ClusterMetadata);
    temporalBridge.deployApp.mockRejectedValue(new DependencyDownError('temporal', '2026-11-13T10:02:00Z', 'it refused the connection (ECONNREFUSED)'));
    const answer = await call('', 'POST', asked);
    expect(answer.status).toBe(503);
    expect(answer.data).toMatchObject({ dependency: 'temporal', reason: 'it refused the connection (ECONNREFUSED)' });
  });

  it('answers a saved credential it can no longer read with 409 and what to do, never as Temporal being down', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue({ id: 'c1' } as ClusterMetadata);
    temporalBridge.deployApp.mockRejectedValue(new UnreadableCredential('huggingface', 'hfToken'));
    const answer = await call('', 'POST', asked);
    expect(answer.status).toBe(409);
    expect(answer.data).toEqual({ error: 'your huggingface hfToken was saved under a key this Koala no longer holds; enter it again under Cloud providers' });
  });

  it('answers a failure it did not expect with 500 and its reason, never as Temporal being down', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue({ id: 'c1' } as ClusterMetadata);
    temporalBridge.deployApp.mockRejectedValue(new Error('the deployment record could not be saved'));
    const answer = await call('', 'POST', asked);
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ error: 'the deployment record could not be saved' });
  });
});

describe('destroying', () => {
  it('starts the destroy workflow and answers 202', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.destroyApp.calledWith('d1').mockResolvedValue(deal('w2'));
    const answer = await call('/d1', 'DELETE');
    expect(answer.status).toBe(202);
    expect(answer.data).toEqual({ message: 'Destroying app', deploymentId: 'd1', workflowId: 'w2', state: 'running' });
  });

  it('aborts a deployment that is still deploying instead of destroying it', async () => {
    const { appService, temporalBridge, call } = setup();
    appService.getById.mockResolvedValue(deployment({ status: 'deploying' }));
    expect((await call('/d1', 'DELETE')).data).toEqual({ success: true, message: 'Deployment aborted' });
    expect(temporalBridge.destroyApp).not.toHaveBeenCalled();
  });

  it('says the deployment is not found when it is not the person\'s', async () => {
    const { call } = setup();
    expect((await call('/elsewhere', 'DELETE')).status).toBe(404);
  });

  it('deletes the record when Temporal cannot be asked, and says both reasons when that fails too', async () => {
    const { appService, temporalBridge, call } = setup();
    temporalBridge.destroyApp.mockRejectedValue(new Error('no worker'));
    expect((await call('/d1', 'DELETE')).data).toEqual({ success: true, message: 'Deployment deleted' });
    appService.abort.mockRejectedValue(new Error('database down'));
    const both = await call('/d1', 'DELETE');
    expect(both.status).toBe(503);
    expect((both.data as { error: string }).error).toBe('Deployment destruction unavailable: no worker; deleting its record failed too: database down');
  });
});

describe('an app\'s details', () => {
  it('shows its sign-in to its owner on asking, never cached, and a stranger\'s as missing', async () => {
    const { appService, call } = setup();
    appService.signIns.calledWith('d1', PERSON.id).mockResolvedValue([{ describe: 'The Hermes dashboard', login: 'admin', password: 'generated' }] as never);
    const answer = await call('/d1/sign-in');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.data).toEqual({ signIns: [{ describe: 'The Hermes dashboard', login: 'admin', password: 'generated' }] });
    expect((await call('/elsewhere/sign-in')).status).toBe(404);
  });

  it('reads helm status and diagnostics as the person asking, answering 500 with the reason when the cluster cannot be reached', async () => {
    const { appService, call } = setup();
    appService.getHelmStatus.calledWith('d1', PERSON.id).mockResolvedValue('deployed');
    appService.getDiagnostics.calledWith('d1', PERSON.id).mockResolvedValue('all good');
    expect((await call('/d1/helm')).data).toEqual({ content: 'deployed' });
    expect((await call('/d1/diagnostics')).data).toEqual({ content: 'all good' });
    appService.getHelmStatus.mockRejectedValue(new Error('cluster unreachable'));
    const down = await call('/d1/helm');
    expect(down.status).toBe(500);
    expect(down.data).toEqual({ error: 'cluster unreachable' });
  });

  it('lists the app\'s pods, and says so when they cannot be listed', async () => {
    const { appService, call } = setup();
    appService.listPods.mockResolvedValueOnce([{ metadata: { name: 'p1' } }] as never);
    expect((await call('/d1/pods')).data).toEqual([{ metadata: { name: 'p1' } }]);
    appService.listPods.mockRejectedValueOnce(new Error('kubectl timeout'));
    const failed = await call('/d1/pods');
    expect(failed.status).toBe(500);
    expect(failed.data).toEqual({ error: 'Failed to list pods' });
  });
});

describe('exposing an app', () => {
  it('exposes it publicly by default and locally when asked', async () => {
    const { appExposureService, call } = setup();
    appExposureService.exposePublic.calledWith('d1').mockResolvedValue({ url: 'https://x' } as never);
    appExposureService.exposeLocal.calledWith('d1').mockResolvedValue({ url: 'http://local' } as never);
    expect((await call('/d1/expose', 'POST', {})).data).toEqual({ url: 'https://x' });
    expect((await call('/d1/expose', 'POST', { mode: 'local' })).data).toEqual({ url: 'http://local' });
  });

  it('says a game server has no web interface to expose', async () => {
    const { appService, call } = setup();
    appService.getById.mockResolvedValue(deployment({ appType: 'palworld' }));
    const answer = await call('/d1/expose', 'POST', {});
    expect(answer.status).toBe(400);
    expect((answer.data as { error: string }).error).toMatch(/"palworld" has no HTTP interface to expose/);
  });

  it('says the deployment is not found, or why exposing failed', async () => {
    const { appExposureService, call } = setup();
    expect((await call('/elsewhere/expose', 'POST', {})).status).toBe(404);
    appExposureService.exposePublic.mockRejectedValue(new Error('no tunnel'));
    const failed = await call('/d1/expose', 'POST', {});
    expect(failed.status).toBe(500);
    expect(failed.data).toEqual({ error: 'no tunnel' });
  });

  it('stops exposing it publicly or locally', async () => {
    const { appExposureService, call } = setup();
    appExposureService.unexposePublic.mockResolvedValue({ ok: true } as never);
    appExposureService.unexposeLocal.mockResolvedValue({ local: true } as never);
    expect((await call('/d1/unexpose', 'POST', {})).data).toEqual({ ok: true });
    expect((await call('/d1/unexpose', 'POST', { mode: 'local' })).data).toEqual({ local: true });
    expect((await call('/elsewhere/unexpose', 'POST', {})).status).toBe(404);
    appExposureService.unexposePublic.mockRejectedValue(new Error('gone'));
    expect((await call('/d1/unexpose', 'POST', {})).status).toBe(500);
  });

  it('changes the path an app is exposed at, only to text', async () => {
    const { appExposureService, call } = setup();
    appExposureService.updateExposurePath.calledWith('d1', '/admin').mockResolvedValue({ path: '/admin' } as never);
    expect((await call('/d1/exposure-path', 'PATCH', { path: '/admin' })).data).toEqual({ path: '/admin' });
    expect((await call('/d1/exposure-path', 'PATCH', { path: 5 })).status).toBe(400);
    expect((await call('/elsewhere/exposure-path', 'PATCH', { path: '/x' })).status).toBe(404);
    appExposureService.updateExposurePath.mockRejectedValue(new Error('bad path'));
    expect((await call('/d1/exposure-path', 'PATCH', { path: '/y' })).status).toBe(500);
  });
});

describe('changing a deployment', () => {
  it('sets the modules of an app, answering 202, only from a list of names', async () => {
    const { appService, call } = setup();
    appService.updateModules.mockResolvedValue({ ok: true } as never);
    const answer = await call('/d1/modules', 'PATCH', { modules: ['sale', 'crm'] });
    expect(answer.status).toBe(202);
    expect(appService.updateModules).toHaveBeenCalledWith('d1', ['sale', 'crm'], PERSON.id, expect.anything());
    expect((await call('/d1/modules', 'PATCH', { modules: [1] })).status).toBe(400);
  });

  it('resizes disks from sizes given as text', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.resizeDisk.calledWith('d1', matches<Record<string, string>>((storage) => storage.data === '20Gi')).mockResolvedValue(deal('w3'));
    const answer = await call('/d1/storage', 'PATCH', { storage: { data: '20Gi' } });
    expect(answer.status).toBe(202);
    expect(answer.data).toEqual({ message: 'Resize started', deploymentId: 'd1', workflowId: 'w3', state: 'running' });
    expect((await call('/d1/storage', 'PATCH', { storage: 5 })).status).toBe(400);
    expect((await call('/elsewhere/storage', 'PATCH', { storage: { data: '1Gi' } })).status).toBe(404);
    temporalBridge.resizeDisk.mockRejectedValue(new Error('no worker'));
    expect((await call('/d1/storage', 'PATCH', { storage: { data: '2Gi' } })).status).toBe(503);
  });

  it('syncs a config change, merging settings the app\'s schema accepts', async () => {
    const { appService, temporalBridge, call } = setup();
    appService.getById.mockResolvedValue(deployment({ appType: 'palworld' }));
    temporalBridge.updateConfigAndSync.mockResolvedValue(deal('w4'));
    const answer = await call('/d1/config', 'PATCH', { vllmGpuCount: 2 });
    expect(answer.status).toBe(202);
    expect(answer.data).toEqual({ message: 'Config updated, sync started', deploymentId: 'd1', workflowId: 'w4', state: 'running' });
  });

  it('decides a change to a model server\'s GPUs against what its machine reports, as a deploy is, and syncs only what it allows', async () => {
    const { appService, clusterService, temporalBridge, call } = setup();
    appService.getById.mockResolvedValue(deployment({ appType: 'vllm', vllmGpuCount: 1, clusterId: 'machine-desk' }));
    clusterService.getById.mockResolvedValue({ id: 'machine-desk', name: 'desk', provider: 'machine', gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: true }] } as never);
    temporalBridge.updateConfigAndSync.mockResolvedValue(deal('w5'));
    expect((await call('/d1/config', 'PATCH', { vllmGpuCount: 4 })).data).toEqual({ error: 'This app asks for 4 NVIDIA GPUs, and desk has 2 NVIDIA GPUs. Ask for 2 or fewer.' });
    expect((await call('/d1/config', 'PATCH', { vllmGpuCount: 0 })).data).toEqual({ error: 'Say how many GPUs vLLM uses: 1 or more. Koala runs no model on CPU.' });
    expect(temporalBridge.updateConfigAndSync).not.toHaveBeenCalled();
    expect((await call('/d1/config', 'PATCH', { vllmGpuCount: 2 })).status).toBe(202);
    expect(temporalBridge.updateConfigAndSync).toHaveBeenCalledWith('d1', { vllmGpuCount: 2, vllmGpuVendor: 'nvidia' });
  });

  it('decides a change to vLLM\'s tool calling by the rules a deploy follows, its parser chosen from the model when none is picked', async () => {
    const { appService, temporalBridge, call } = setup();
    appService.getById.mockResolvedValue(deployment({ appType: 'vllm', vllmGpuCount: 1, vllmModel: 'Qwen/Qwen3-8B' }));
    temporalBridge.updateConfigAndSync.mockResolvedValue(deal('w6'));
    expect((await call('/d1/config', 'PATCH', { vllmToolCallingEnabled: true, vllmToolCallParser: 'made-up' })).data).toEqual({ error: 'made-up is not a tool call parser vLLM v0.32.0 has' });
    expect((await call('/d1/config', 'PATCH', { vllmModel: 'someone/their-own-model', vllmToolCallingEnabled: true })).data).toEqual({ error: 'Koala cannot tell which tool call parser vLLM needs for someone/their-own-model: pick one, or turn tool calling off' });
    expect(temporalBridge.updateConfigAndSync).not.toHaveBeenCalled();
    expect((await call('/d1/config', 'PATCH', { vllmToolCallingEnabled: true, vllmToolCallParser: '' })).status).toBe(202);
    expect(temporalBridge.updateConfigAndSync).toHaveBeenLastCalledWith('d1', { vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' });
    expect((await call('/d1/config', 'PATCH', { vllmToolCallingEnabled: false })).status).toBe(202);
    expect(temporalBridge.updateConfigAndSync).toHaveBeenLastCalledWith('d1', { vllmToolCallingEnabled: false });
  });

  it('refuses a config that is not one, settings for an app without a schema, and settings the schema rejects', async () => {
    const { appService, call } = setup();
    expect((await call('/d1/config', 'PATCH', { vllmGpuCount: 'many' })).status).toBe(400);
    expect((await call('/d1/config', 'PATCH', { appSettings: { a: 1 } })).data).toEqual({ error: 'App type "odoo" has no settings schema' });
    appService.getById.calledWith('d1', PERSON.id).mockResolvedValue(deployment({ appType: 'palworld' }));
    const invalid = await call('/d1/config', 'PATCH', { appSettings: { serverName: 12345, maxPlayers: 'many' } });
    expect(invalid.status).toBe(400);
    expect(invalid.data).toMatchObject({ error: 'Invalid settings' });
    expect((await call('/elsewhere/config', 'PATCH', { vllmGpuCount: 1 })).status).toBe(404);
  });

  it('reports Temporal being down as 503, not as a bad patch', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.updateConfigAndSync.mockRejectedValue(new Error('no worker'));
    expect((await call('/d1/config', 'PATCH', { vllmGpuCount: 2 })).status).toBe(503);
  });
});

describe('a TabbyAPI deployment\'s resource plan', () => {
  const tabby = () => {
    const parts = setup();
    parts.appService.getById.mockResolvedValue(deployment({ appType: 'tabbyapi', tabbyModel: 'org/model' }));
    server.use(http.get('https://huggingface.co/api/models/org/model/tree/main', () => HttpResponse.json([{ type: 'file', path: 'model.safetensors', size: 20e9 }])));
    return parts;
  };

  it('says the plan does not apply to any other app', async () => {
    const { call } = setup();
    expect((await call('/d1/resource-plan')).data).toEqual({ applicable: false });
    expect((await call('/elsewhere/resource-plan')).status).toBe(404);
  });

  it('budgets against the memory the cluster\'s machine reported', async () => {
    const { clusterService, call } = tabby();
    clusterService.getById.mockResolvedValue({ id: 'c1', name: 'desk', provider: 'machine', status: 'stopped', capacity: { cpuCores: 4, ramGb: 4 } });
    const answer = await call('/d1/resource-plan');
    expect(answer.data).toMatchObject({ applicable: true, cpuLimit: '10' });
    expect((answer.data as { refusal?: string }).refusal).toMatch(/allocatable/);
  });

  it('says it did not check the plan against the machine when its machine has not said how much memory it has, and refuses nothing', async () => {
    const { clusterService, call } = tabby();
    clusterService.getById.mockResolvedValue({ id: 'c1', name: 'desk', provider: 'machine', status: 'stopped' });
    const answer = await call('/d1/resource-plan');
    expect(answer.data).toMatchObject({ applicable: true, unbudgeted: expect.stringMatching(/^desk has not said how much memory it has/) as unknown });
    expect((answer.data as { refusal?: string }).refusal).toBeUndefined();
  });

  it('says what to set, and plans nothing, when the model\'s size cannot be looked up', async () => {
    const { call } = tabby();
    server.use(http.get('https://huggingface.co/api/models/org/model/tree/main', () => new HttpResponse(null, { status: 500 })));
    const plan = (await call('/d1/resource-plan')).data as Record<string, unknown>;
    expect(plan.applicable).toBe(true);
    expect(plan.unsized).toMatch(/^Koala could not read how big org\/model is from Hugging Face \(.*500.*\), so it cannot size the memory it needs\./);
    expect(plan).not.toHaveProperty('memoryLimit');
    expect(plan).not.toHaveProperty('basis');
  });
});
