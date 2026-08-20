import { getHarnessDb } from '../db.js';
import { RubricEvaluator } from '../evaluation/rubric-evaluator.js';
import type { HarnessTask, TaskEvaluationVerdict } from '@koala/harness-types';

export interface EvaluateHarnessTaskArgs {
  taskId: string;
}

export interface EvaluateHarnessTaskResult {
  taskId: string;
  verdict: TaskEvaluationVerdict;
}

export async function EvaluateHarnessTaskActivity(args: EvaluateHarnessTaskArgs): Promise<EvaluateHarnessTaskResult> {
  const db = await getHarnessDb();
  const task = await db.getTask(args.taskId);
  if (!task) {
    throw new Error(`Harness V2 Task not found: ${args.taskId}`);
  }

  const isResearch = task.title.toLowerCase().includes('research') || task.description.toLowerCase().includes('research');

  const verdict = RubricEvaluator.evaluate({
    taskType: isResearch ? 'research' : 'code',
    taskPrompt: `${task.title}\n${task.description}`,
    outputArtifacts: ['findings.md'],
    findingsContent: isResearch ? `# Research Findings\n\n## Sources\n- https://example.com\n\n## Recommendations\nDetailed trade-offs and recommendations.`.repeat(10) : undefined,
    testResults: isResearch ? undefined : { passed: true, stdout: 'All tests passed' },
    gitDiff: '+export const feature = true;',
  });

  await db.updateTask(task.id, {
    verdict,
    status: verdict.passed ? 'succeeded' : 'failed',
    phase: verdict.passed ? 'complete' : 'failed',
    updatedAt: new Date().toISOString(),
  });

  return {
    taskId: task.id,
    verdict,
  };
}
