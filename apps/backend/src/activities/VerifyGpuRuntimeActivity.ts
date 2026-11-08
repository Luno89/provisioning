import { installGpuDevicePlugin, verifyGpuRuntimeSchedulable, type Reach } from '../infrastructure/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';

export interface VerifyGpuRuntimeArgs {
  clusterId: string;
  reach?: Reach | undefined;
  vendor: 'nvidia' | 'amd';
}

export async function VerifyGpuRuntimeActivity(args: VerifyGpuRuntimeArgs, steps: Pick<ClusterSteps, 'access'>): Promise<void> {
  const reach = handedReach(args);
  const kubectl = (argv: string[]) => steps.access.kubectl(reach, argv);
  await installGpuDevicePlugin(kubectl, args.vendor);
  await verifyGpuRuntimeSchedulable(kubectl, args.vendor);
}
