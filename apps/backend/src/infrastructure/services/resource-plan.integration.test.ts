import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams, type DeploymentMetadata } from '../../platform/index.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { getHfModelSize } from '../lib/huggingface.js';
import { TOOLS } from '../testing/real-k3s.js';
import { ClusterAccess } from './ClusterAccess.js';
import { resourcePlanOf } from './resource-plan.js';

const k3s = inject('k3s');
const huggingFace = interceptHttp();
const MODEL_TREE = 'https://huggingface.co/api/models/org/model/tree/*';
const access = new ClusterAccess({
  here: { koalaMachineId: 'dev1', root: false },
  folder: mkdtempSync(join(tmpdir(), 'koala-resource-plan-')),
  processes: nodeProcesses,
  streams: nodeStreams,
  tools: TOOLS,
  serviceAccount: k3s.account,
});
const own = access.own();

const tabby: DeploymentMetadata = { id: 'd1', name: 'qwen', clusterId: own.clusterId, strategy: 'native', status: 'running', appType: 'tabbyapi', tabbyModel: 'org/model', tabbyGpuCount: 1, tabbyMaxSeqLen: 4096 };
const deps = {
  modelSize: getHfModelSize,
  nodeMemory: () => access.kubectl(own, ['get', 'nodes', '-o', 'jsonpath={.items[*].status.allocatable.memory}']),
};

describe('the memory a TabbyAPI app is planned to need, from Hugging Face and the cluster\'s own nodes', () => {
  it('is sized from what Hugging Face says the model weighs, against the memory k3s says its node has', async () => {
    huggingFace.use(http.get(MODEL_TREE, () => HttpResponse.json([{ type: 'file', path: 'model.safetensors', size: 4e9 }])));
    const plan = await resourcePlanOf(tabby, deps);
    expect(plan).toMatchObject({ applicable: true, cpuLimit: '10', basis: expect.stringMatching(/^3\.7 GiB of weights/) as unknown });
  });

  it('says what to set when Hugging Face cannot say how big the model is', async () => {
    huggingFace.use(http.get(MODEL_TREE, () => new HttpResponse(null, { status: 503 })));
    const plan = await resourcePlanOf(tabby, deps);
    expect(plan).toEqual({ applicable: true, unsized: expect.stringMatching(/^Koala could not read how big org\/model is from Hugging Face \(.*503.*\), so it cannot size the memory it needs\. Set its Memory Limit/) as unknown });
  });
});
