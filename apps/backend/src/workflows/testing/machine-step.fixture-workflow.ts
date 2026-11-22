import { proxyActivities } from '@temporalio/workflow';
import { deviceQueue } from '../../engine-host/temporal/contracts.js';
import { TEMPORAL_REQUIRED_START_TO_CLOSE } from '../../platform/lib/activity-liveness.js';

export interface MachineStep {
  MachineStepActivity(args: { projectId: string }): Promise<string>;
}

export const MACHINE_STEP_LIVENESS = '2 seconds';

export const MACHINE_STEP_STARTED = 'started';
export const MACHINE_STEP_ASKED_TO_STOP = 'asked to stop';

export async function MachineStepWorkflow(args: { projectId: string; deviceId: string }): Promise<string> {
  const onMachine = proxyActivities<MachineStep>({
    taskQueue: deviceQueue(args.deviceId),
    startToCloseTimeout: TEMPORAL_REQUIRED_START_TO_CLOSE,
    heartbeatTimeout: MACHINE_STEP_LIVENESS,
    cancellationType: 'WAIT_CANCELLATION_COMPLETED',
    retry: { maximumAttempts: 1 },
  });
  return onMachine.MachineStepActivity({ projectId: args.projectId });
}
