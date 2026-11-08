import { ApplicationFailure } from '@temporalio/workflow';
import { startedMachine } from '../infrastructure/lib/cluster-places.js';
import type { MachineOfCluster, Reach } from '../infrastructure/index.js';

export interface HandedArgs {
  clusterId: string;
  machine?: MachineOfCluster | undefined;
  reach?: Reach | undefined;
}

export async function handedOver<T extends HandedArgs>(given: T, start: (machine: MachineOfCluster, clusterId: string) => Promise<string>): Promise<T & { reach: Reach }> {
  if (given.machine) return { ...given, reach: startedMachine(given.clusterId, await start(given.machine, given.clusterId)) };
  if (given.reach) return { ...given, reach: given.reach };
  throw ApplicationFailure.nonRetryable(`this work was started with no way to reach ${given.clusterId}: a release of Koala that reached clusters another way started it, so start it again`, 'NoReachHanded');
}
