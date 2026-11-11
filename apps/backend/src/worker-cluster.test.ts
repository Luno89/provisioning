import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterSteps } from './activities/cluster-steps.js';
import type { Reach } from './infrastructure/index.js';
import { clusterActivities } from './worker-cluster.js';

describe('the activities the cluster worker serves', () => {
  it('are each called by Temporal with their arguments alone, the worker supplying what else they need', () => {
    const taking = Object.entries(clusterActivities(mock<ClusterSteps>())).filter(([, activity]) => activity.length > 1).map(([name]) => name);
    expect(taking).toEqual([]);
  });

  it('download a model through the worker\'s own way to the cluster', async () => {
    const steps = mock<ClusterSteps>({ access: mock() });
    steps.access.apply.mockResolvedValue('');
    steps.access.kubectl.mockImplementation(async (_target, args) => (args.includes('jsonpath={.status.succeeded}|{.status.failed}') ? '1|' : ''));
    const reach = { clusterId: 'machine-desk', kind: 'koala' } as Reach;
    await clusterActivities(steps).DownloadModelActivity({ clusterId: 'machine-desk', reach, image: 'vllm/vllm-openai:v0.7.2', modelRepo: 'acme/tiny', cacheHostPath: '/var/lib/rancher/vllm-model-cache' });
    expect(steps.access.apply).toHaveBeenCalled();
  });
});
