import { namespaceOf, ROLLOUT_KINDS, rolloutOf, type Reach, type WorkloadHealth } from '../infrastructure/index.js';
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
    const rollout = rolloutOf(JSON.parse(await steps.access.kubectl(reach, ['get', ROLLOUT_KINDS, '-n', namespaceOf(args), '-o', 'json'])));
    if (rollout.state === 'done') return { health: 'healthy', reason: '' };
    if (rollout.state === 'hopeless') return { health: 'unhealthy', reason: rollout.reason };
    return { health: 'starting', reason: rollout.waiting };
  } catch (err) {
    return { health: 'unknown', reason: `could not read the workload: ${(err as Error).message}` };
  }
}
