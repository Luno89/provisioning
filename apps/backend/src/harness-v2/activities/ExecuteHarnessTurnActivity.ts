import { getHarnessDb } from '../db.js';
import { DurableRunner } from '../engine/durable-runner.js';
import type { TurnExecutionStep, HarnessTask } from '@koala/harness-types';

export interface ExecuteHarnessTurnArgs {
  taskId: string;
}

export interface ExecuteHarnessTurnResult {
  taskId: string;
  turnIndex: number;
  finished: boolean;
  needsContextReset: boolean;
  tokensUsed: number;
  step: TurnExecutionStep;
}

export async function ExecuteHarnessTurnActivity(args: ExecuteHarnessTurnArgs): Promise<ExecuteHarnessTurnResult> {
  const db = await getHarnessDb();
  const task = await db.getTask(args.taskId);
  if (!task) {
    throw new Error(`Harness V2 Task not found: ${args.taskId}`);
  }

  const turnIndex = task.budget.turnsCompleted + 1;

  // Local in-memory sandbox driver for testing & workspace isolation
  const sandbox = {
    exec: async (command: string) => {
      return { stdout: `Executed: ${command}`, stderr: '', exitCode: 0 };
    },
    readFile: async (path: string) => {
      return `Sample content of ${path}`;
    },
    writeFile: async () => {},
  };

  // Synthetic model turn generation or integration with ModelService
  const modelResponse = {
    promptTokens: 250,
    completionTokens: 80,
    content: `Executing step ${turnIndex} for ${task.title}`,
    toolCalls: turnIndex >= task.budget.maxTurns
      ? [{ id: `call-${turnIndex}`, name: 'finish', args: { summary: 'Completed task within allotted budget' } }]
      : [{ id: `call-${turnIndex}`, name: 'run_command', args: { command: `echo "Step ${turnIndex}"` } }],
  };

  const result = await DurableRunner.processTurn({
    taskId: task.id,
    turnIndex,
    phase: task.phase,
    personaId: task.personaId,
    workspacePath: `/work/${task.id}`,
    sandbox,
    modelResponse,
  });

  const tokensUsed = modelResponse.promptTokens + modelResponse.completionTokens;

  // Persist trace step and update task state
  await db.addTrace(task.id, result.step);

  await db.updateTask(task.id, {
    budget: {
      ...task.budget,
      turnsCompleted: turnIndex,
      tokensUsed: task.budget.tokensUsed + tokensUsed,
    },
    updatedAt: new Date().toISOString(),
    ...(result.finished ? { status: 'evaluating', phase: 'evaluate' } : {}),
  });

  return {
    taskId: task.id,
    turnIndex,
    finished: result.finished,
    needsContextReset: result.needsContextReset,
    tokensUsed,
    step: result.step,
  };
}
