import { ApplicationFailure } from '@temporalio/common';
import { startedMachine, type Reach } from '../infrastructure/index.js';

export interface HandedCluster {
  clusterId: string;
  reach?: Reach | undefined;
  kubeconfig?: string | undefined;
}

export function handedReach(handed: HandedCluster): Reach {
  if (handed.reach) return handed.reach;
  if (handed.kubeconfig) return startedMachine(handed.clusterId, handed.kubeconfig);
  throw ApplicationFailure.nonRetryable(`this step was handed no way to reach ${handed.clusterId}: it was started by a release of Koala that reached clusters another way, so start it again`, 'NoReachHanded');
}
