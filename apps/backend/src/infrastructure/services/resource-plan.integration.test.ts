import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { asPerson, type DeploymentMetadata } from '../../platform/index.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { getHfModelSize } from '../lib/huggingface.js';
import { testClusterAccess } from '../testing/cluster-access.js';
import { ClusterService } from './ClusterService.js';
import { resourcePlanOf, type ResourcePlanDeps } from './resource-plan.js';

const fresh = await emptiedEachTime();
const huggingFace = interceptHttp();
const MODEL_TREE = 'https://huggingface.co/api/models/org/model/tree/*';
const tabby: DeploymentMetadata = { id: 'd1', name: 'qwen', clusterId: 'machine-desk', strategy: 'native', status: 'running', appType: 'tabbyapi', tabbyModel: 'org/model', tabbyGpuCount: 1, tabbyMaxSeqLen: 4096 };

let db: MongoDB;
let deps: ResourcePlanDeps;

beforeEach(async () => {
  db = await fresh();
  const clusters = new ClusterService(db, testClusterAccess(db, { dataKey: 'resource-plan-key' }));
  deps = { modelSize: getHfModelSize, clusterOf: (clusterId) => clusters.getById(clusterId, asPerson('bo')) };
});

describe('the memory a TabbyAPI app is planned to need, from Hugging Face and what its machine reported', () => {
  it('is sized from what Hugging Face says the model weighs, against the memory its machine reported', async () => {
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'desk', capacity: { cpuCores: 16, ramGb: 64 } });
    huggingFace.use(http.get(MODEL_TREE, () => HttpResponse.json([{ type: 'file', path: 'model.safetensors', size: 4e9 }])));
    const plan = await resourcePlanOf(tabby, deps);
    expect(plan).toMatchObject({ applicable: true, cpuLimit: '10', basis: expect.stringMatching(/^3\.7 GiB of weights/) as unknown });
    expect(plan).not.toHaveProperty('unbudgeted');
  });

  it('says it did not check the plan against the machine when the machine has not said how much memory it has', async () => {
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'desk' });
    huggingFace.use(http.get(MODEL_TREE, () => HttpResponse.json([{ type: 'file', path: 'model.safetensors', size: 4e9 }])));
    expect(await resourcePlanOf(tabby, deps)).toMatchObject({ applicable: true, unbudgeted: expect.stringMatching(/^desk has not said how much memory it has/) as unknown });
  });

  it('says what to set when Hugging Face cannot say how big the model is', async () => {
    huggingFace.use(http.get(MODEL_TREE, () => new HttpResponse(null, { status: 503 })));
    const plan = await resourcePlanOf(tabby, deps);
    expect(plan).toEqual({ applicable: true, unsized: expect.stringMatching(/^Koala could not read how big org\/model is from Hugging Face \(.*503.*\), so it cannot size the memory it needs\. Set its Memory Limit/) as unknown });
  });
});
