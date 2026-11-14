import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { DeploymentMetadata } from '../../platform/index.js';
import { resourcePlanOf, type ResourcePlanDeps } from './resource-plan.js';

const tabby = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({ id: 'd1', name: 'qwen', clusterId: 'c1', strategy: 'native', status: 'running', appType: 'tabbyapi', tabbyModel: 'org/model', tabbyGpuCount: 1, tabbyMaxSeqLen: 4096, ...over });

const deps = () => {
  const given = mock<ResourcePlanDeps>();
  given.modelSize.mockResolvedValue({ totalBytes: 4e9 });
  given.clusterOf.mockResolvedValue({ name: 'desk', capacity: { cpuCores: 16, ramGb: 64 } });
  return given;
};

describe('the memory a TabbyAPI app is planned to need', () => {
  it('applies only to TabbyAPI', async () => {
    expect(await resourcePlanOf(tabby({ appType: 'vllm' }), deps())).toEqual({ applicable: false });
  });

  it('is sized from the model\'s real size against the memory its machine reported', async () => {
    const given = deps();
    const plan = await resourcePlanOf(tabby(), given);
    expect(plan).toMatchObject({ applicable: true, cpuLimit: '10', basis: expect.stringMatching(/^3\.7 GiB of weights, 1 GPU, seq len 4096/) as unknown });
    expect(plan).not.toHaveProperty('unbudgeted');
    expect(given.modelSize).toHaveBeenCalledWith('org/model', undefined, undefined);
    expect(given.clusterOf).toHaveBeenCalledWith('c1');
  });

  it('refuses a model that would not fit in the memory its machine reported', async () => {
    const given = deps();
    given.clusterOf.mockResolvedValue({ name: 'desk', capacity: { cpuCores: 4, ramGb: 4 } });
    expect(await resourcePlanOf(tabby(), given)).toMatchObject({ applicable: true, refusal: expect.any(String) as unknown });
  });

  it('says what to set, and plans nothing, when the model\'s size cannot be read', async () => {
    const given = deps();
    given.modelSize.mockRejectedValue(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));
    expect(await resourcePlanOf(tabby(), given)).toEqual({ applicable: true, unsized: expect.stringMatching(/^Koala could not read how big org\/model is from Hugging Face \(.+\), so it cannot size the memory it needs\./) as unknown });
    expect(given.clusterOf).not.toHaveBeenCalled();
  });

  it('says it could not check the plan against the machine when the machine has not said how much memory it has', async () => {
    const given = deps();
    given.clusterOf.mockResolvedValue({ name: 'desk' });
    const plan = await resourcePlanOf(tabby(), given);
    expect(plan).toMatchObject({ applicable: true, unbudgeted: 'desk has not said how much memory it has, so whether this fits there is not checked: its agent is from before machines reported their size, or it has not connected since. Once it connects with a current agent, it says.' });
    expect(plan).not.toHaveProperty('refusal');
  });
});
