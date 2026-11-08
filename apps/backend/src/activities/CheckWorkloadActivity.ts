import { namespaceOf, assessWorkload, creationRefused, type Reach, type WorkloadHealth } from '../infrastructure/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';

export interface CheckWorkloadArgs {
  name: string;
  namespace?: string | undefined;
  clusterId: string;
  reach?: Reach | undefined;
  kubeconfig?: string | undefined;
}

export interface CheckWorkloadResult {
  health: WorkloadHealth;
  reason: string;
}

export async function CheckWorkloadActivity(args: CheckWorkloadArgs, steps: Pick<ClusterSteps, 'access'>): Promise<CheckWorkloadResult> {
  const reach = handedReach(args);
  try {
    const raw = await steps.access.kubectl(reach, ['get', 'pods', '-n', namespaceOf(args), '-o', 'json']);
    const pods = assessWorkload(JSON.parse(raw));
    if (pods.health !== 'starting') return pods;
    const controllers = await steps.access.kubectl(reach, ['get', 'deployments,replicasets', '-n', namespaceOf(args), '-o', 'json']);
    return creationRefused(JSON.parse(controllers)) ?? pods;
  } catch (err) {
    return { health: 'unknown', reason: `could not read the workload: ${(err as Error).message}` };
  }
}
