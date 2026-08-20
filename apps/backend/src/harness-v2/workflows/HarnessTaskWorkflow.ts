/**
 * HarnessTaskWorkflow — Temporal Workflow for Turn-by-Turn Durable Execution in Harness V2.
 */
import { proxyActivities, defineSignal, defineQuery, setHandler, condition } from '@temporalio/workflow';
import type { ExecuteHarnessTurnArgs, ExecuteHarnessTurnResult } from '../activities/ExecuteHarnessTurnActivity.js';
import type { EvaluateHarnessTaskArgs, EvaluateHarnessTaskResult } from '../activities/EvaluateHarnessTaskActivity.js';

const { ExecuteHarnessTurnActivity } = proxyActivities<{ ExecuteHarnessTurnActivity: (args: ExecuteHarnessTurnArgs) => Promise<ExecuteHarnessTurnResult> }>({
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2 seconds',
  },
});

const { EvaluateHarnessTaskActivity } = proxyActivities<{ EvaluateHarnessTaskActivity: (args: EvaluateHarnessTaskArgs) => Promise<EvaluateHarnessTaskResult> }>({
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 2,
    initialInterval: '2 seconds',
  },
});

export const pauseSignal = defineSignal('pause');
export const resumeSignal = defineSignal('resume');
export const getTaskStatusQuery = defineQuery<string>('getStatus');

export interface HarnessTaskWorkflowArgs {
  taskId: string;
  maxTurns?: number;
}

export async function HarnessTaskWorkflow(args: HarnessTaskWorkflowArgs): Promise<{ status: string; turnsExecuted: number }> {
  let isPaused = false;
  let isCancelled = false;
  let turnsExecuted = 0;
  const maxTurns = args.maxTurns || 30;

  setHandler(pauseSignal, () => {
    isPaused = true;
  });

  setHandler(resumeSignal, () => {
    isPaused = false;
  });

  setHandler(getTaskStatusQuery, () => {
    return isPaused ? 'paused' : 'running';
  });

  while (turnsExecuted < maxTurns && !isCancelled) {
    if (isPaused) {
      await condition(() => !isPaused);
    }

    const turnResult = await ExecuteHarnessTurnActivity({ taskId: args.taskId });
    turnsExecuted++;

    if (turnResult.finished) {
      break;
    }
  }

  // Final independent evaluation
  await EvaluateHarnessTaskActivity({ taskId: args.taskId });

  return {
    status: 'succeeded',
    turnsExecuted,
  };
}
