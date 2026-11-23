import { ApplicationFailure } from '@temporalio/workflow';
import type { MachineClusterResult } from '@koala/engine-core';

export interface StopSteps {
  idle(): Promise<boolean>;
  stop(): Promise<MachineClusterResult>;
  stopped(): Promise<void>;
}

export async function stoppedWhenIdle(steps: StopSteps): Promise<boolean> {
  if (!await steps.idle()) return false;
  const answered = await steps.stop();
  if (answered.state === 'kept') return false;
  if (answered.state === 'running') throw ApplicationFailure.nonRetryable('the machine answered running when its cluster was stopped', 'MachineClusterNotStopped');
  await steps.stopped();
  return true;
}
