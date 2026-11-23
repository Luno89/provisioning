export type MachineClusterOp = { kind: 'start' } | { kind: 'stop' };

export type MachineClusterResult =
  | { state: 'running'; kubeconfig: string; meshIp: string }
  | { state: 'stopped' }
  | { state: 'kept'; why: string }
  | { state: 'absent' };

export const MACHINE_CLUSTER_KEPT = 'kept: it holds your Koala';

export interface MachineWorkStop {
  workflowIds: string[];
}

export interface MachineWorkStopped {
  killed: string[];
}

export const MACHINE_CLUSTER_ABSENT = 'k3s is not installed on this machine; run the command from My Machines again to install it';
export const MACHINE_OFF_MESH = 'this machine is not on the private network, so its Koala cannot reach its cluster';
