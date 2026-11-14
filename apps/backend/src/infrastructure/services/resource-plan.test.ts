import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { DeploymentMetadata } from '../../platform/index.js';
import { resourcePlanOf, type ResourcePlanDeps } from './resource-plan.js';

const tabby = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({ id: 'd1', name: 'qwen', clusterId: 'c1', strategy: 'native', status: 'running', appType: 'tabbyapi', tabbyModel: 'org/model', tabbyGpuCount: 1, tabbyMaxSeqLen: 4096, ...over });

const deps = () => {
  const given = mock<ResourcePlanDeps>();
  given.modelSize.mockResolvedValue({ totalBytes: 4e9 });
  given.nodeMemory.mockResolvedValue('64Gi');
  return given;
};

describe('the memory a TabbyAPI app is planned to need', () => {
  it('applies only to TabbyAPI', async () => {
    expect(await resourcePlanOf(tabby({ appType: 'vllm' }), deps())).toEqual({ applicable: false });
  });

  it('is sized from the model\'s real size against the smallest node', async () => {
    const given = deps();
    given.nodeMemory.mockResolvedValue('64Gi 32Gi');
    const plan = await resourcePlanOf(tabby(), given);
    expect(plan).toMatchObject({ applicable: true, cpuLimit: '10', basis: expect.stringMatching(/^3\.7 GiB of weights, 1 GPU, seq len 4096/) as unknown });
    expect(given.modelSize).toHaveBeenCalledWith('org/model', undefined, undefined);
    expect(given.nodeMemory).toHaveBeenCalledWith('c1');
  });

  it('says what to set, and plans nothing, when the model\'s size cannot be read', async () => {
    const given = deps();
    given.modelSize.mockRejectedValue(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));
    expect(await resourcePlanOf(tabby(), given)).toEqual({ applicable: true, unsized: expect.stringMatching(/^Koala could not read how big org\/model is from Hugging Face \(.+\), so it cannot size the memory it needs\./) as unknown });
    expect(given.nodeMemory).not.toHaveBeenCalled();
  });

  it('plans with no budget to check when the nodes\' memory cannot be read', async () => {
    const given = deps();
    given.nodeMemory.mockRejectedValue(new Error('the cluster did not answer'));
    const plan = await resourcePlanOf(tabby(), given);
    expect(plan).toMatchObject({ applicable: true });
    expect(plan).not.toHaveProperty('refusal');
  });
});
