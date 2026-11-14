import axios from 'axios';
import { http, HttpResponse, passthrough } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { DeploymentMetadata } from '../../platform/index.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { interceptHttp } from '../../platform/testing/http.js';
import type { AppService } from '../services/AppService.js';
import { ClusterService } from '../services/ClusterService.js';
import { testClusterAccess } from '../testing/cluster-access.js';
import { deploymentsRouter } from './deployments.js';

const fresh = await emptiedEachTime();
const huggingFace = interceptHttp();
const ANN = { id: 'ann', email: 'ann@resource-plan.test' };
const TABBY: DeploymentMetadata = { id: 'd1', name: 'qwen', clusterId: 'machine-desk', ownerId: ANN.id, strategy: 'native', status: 'running', appType: 'tabbyapi', tabbyModel: 'org/model', tabbyGpuCount: 1, tabbyMaxSeqLen: 4096 };

let db: MongoDB;
let h: Harness;

beforeAll(async () => {
  db = await fresh();
  const apps = mock<AppService>();
  apps.getById.mockImplementation(async (id, ownerId) => (id === TABBY.id && ownerId === ANN.id ? TABBY : undefined));
  h = await mountRouter({
    prefix: '/api/deployments',
    db,
    router: () => deploymentsRouter({ appService: apps, clusterService: new ClusterService(db, testClusterAccess(db, { dataKey: 'resource-plan-route-key' })), appExposureService: {} as never, temporalBridge: {} as never, db, io: undefined as never }),
  });
  h.setUser(ANN);
});

beforeEach(async () => {
  for (const cluster of await db.infrastructure.getClusters()) await db.infrastructure.deleteCluster(cluster.id);
  huggingFace.use(
    http.get('https://huggingface.co/api/models/org/model/tree/*', () => HttpResponse.json([{ type: 'file', path: 'model.safetensors', size: 20e9 }])),
    http.all(`${h.url('/api/deployments')}/*`, () => passthrough()),
  );
});

afterAll(async () => { await h?.close(); });

describe('a TabbyAPI app\'s memory plan, read through the route with the cluster as its machine reported it', () => {
  it('refuses a model that does not fit in the memory the person\'s machine reported', async () => {
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'stopped', ownerId: ANN.id, capacity: { cpuCores: 8, ramGb: 16 } });
    const plan = (await axios.get<Record<string, unknown>>(h.url('/api/deployments/d1/resource-plan'))).data;
    expect(plan).toMatchObject({ applicable: true, refusal: expect.stringMatching(/allocatable/) as unknown });
    expect(plan).not.toHaveProperty('unbudgeted');
  });

  it('says the plan was not checked there when the machine has not said how much memory it has', async () => {
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'stopped', ownerId: ANN.id });
    const plan = (await axios.get<Record<string, unknown>>(h.url('/api/deployments/d1/resource-plan'))).data;
    expect(plan).toMatchObject({ applicable: true, unbudgeted: expect.stringMatching(/^desk has not said how much memory it has/) as unknown });
  });
});
