import type { AxiosInstance } from 'axios';
import { devKubectl } from './dev-stack.js';

interface Deployment { name: string; clusterId: string; appType?: string; namespace?: string; status: string; vllmGpuCount?: number; tabbyGpuCount?: number }

export interface StoppedModel { namespace: string; name: string; replicas: number }

export async function stopOwnersModels(api: AxiosInstance, clusterId: string): Promise<StoppedModel[]> {
  const stopped: StoppedModel[] = [];
  const models = ((await api.get('/api/deployments')).data as Deployment[]).filter((entry) => entry.clusterId === clusterId && (entry.appType === 'vllm' || entry.appType === 'tabbyapi') && entry.status === 'running' && ((entry.vllmGpuCount ?? entry.tabbyGpuCount ?? 0) > 0));
  for (const model of models) {
    const namespace = model.namespace ?? model.name;
    const workloads = JSON.parse(await devKubectl(namespace, 'get', 'deployments', '-o', 'json')) as { items: { metadata: { name: string }; spec: { replicas: number } }[] };
    for (const workload of workloads.items.filter((entry) => entry.spec.replicas > 0)) {
      await devKubectl(namespace, 'scale', 'deployment', workload.metadata.name, '--replicas=0');
      stopped.push({ namespace, name: workload.metadata.name, replicas: workload.spec.replicas });
    }
  }
  return stopped;
}

export async function startOwnersModels(stopped: readonly StoppedModel[]): Promise<void> {
  for (const entry of stopped) await devKubectl(entry.namespace, 'scale', 'deployment', entry.name, `--replicas=${entry.replicas}`);
}

export const describeStopped = (stopped: readonly StoppedModel[]): string => stopped.map((entry) => `${entry.namespace}/${entry.name} (${entry.replicas})`).join(', ');
