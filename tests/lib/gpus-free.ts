import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

interface Deployment { name: string; clusterId: string; status: string; vllmGpuCount?: number; tabbyGpuCount?: number }

export async function noAppHoldsAGpu(api: AxiosInstance, clusterId: string): Promise<void> {
  const holding = ((await api.get('/api/deployments')).data as Deployment[]).filter((entry) => entry.clusterId === clusterId && (entry.vllmGpuCount ?? entry.tabbyGpuCount ?? 0) > 0);
  assert.deepEqual(holding.map((entry) => `${entry.name} (${entry.status})`), [], `apps on ${clusterId} ask for its GPUs before this suite began, left by an earlier run: the stack is not as a reset leaves it`);
}
