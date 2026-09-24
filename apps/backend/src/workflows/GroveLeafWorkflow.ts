import { executeChild, proxyActivities } from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import { nextLeafStep } from '../lib/grove-leaf.js';
import { leafContext, leafWorktree } from '../lib/plan-documents.js';
import { AgentRunWorkflow } from './AgentRunWorkflow.js';
import type {
  GroveClaimArgs,
  GroveClaimOutcome,
  GroveLeafArgs,
  GroveLeafResult,
  GroveLeafTasksArgs,
  GroveLeafTaskView,
  ProcedureRunInput,
  ResolveAgentArgs,
  ResolvedAgentInfo,
} from '../engine-host/temporal/contracts.js';

const MAX_ROUNDS = 24;

const { GroveLeafTasksActivity, GroveClaimActivity, EngineResolveAgentActivity } = proxyActivities<{
  GroveLeafTasksActivity(args: GroveLeafTasksArgs): Promise<GroveLeafTaskView[]>;
  GroveClaimActivity(args: GroveClaimArgs): Promise<GroveClaimOutcome>;
  EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo>;
}>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '5 minutes',
});

export async function GroveLeafWorkflow(args: GroveLeafArgs): Promise<GroveLeafResult> {
  const claim = async (result: 'claimed' | 'failed', reason?: string): Promise<GroveLeafResult> => {
    const filed = await GroveClaimActivity({ treeId: args.treeId, ownerId: args.ownerId, leafId: args.leafId, result, ...(reason ? { reason } : {}) });
    if (!filed.ok) return { leafId: args.leafId, outcome: 'failed', reason: `the claim was refused: ${filed.digest}` };
    return { leafId: args.leafId, outcome: result, ...(reason ? { reason } : {}) };
  };

  const executor = await EngineResolveAgentActivity({ ownerId: args.ownerId, agentSlug: 'executor' });
  if (!executor.found || !executor.procedure) return claim('failed', 'there is no executor to work the leaf\'s tasks');

  const worktree = leafWorktree(args.leafId);
  const environment = args.environment.kind === 'sandbox' ? { ...args.environment, worktree } : args.environment;
  const attempts: Record<string, number> = {};

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const tasks = await GroveLeafTasksActivity({ ownerId: args.ownerId, leafId: args.leafId });
    const step = nextLeafStep(tasks, attempts);

    if (step.kind === 'unbroken') return { leafId: args.leafId, outcome: 'unbroken' };
    if (step.kind === 'claim') return claim('claimed');
    if (step.kind === 'fail') return claim('failed', step.reason);

    const taskId = step.taskIds[0]!;
    const task = tasks.find((entry) => entry.id === taskId)!;
    attempts[taskId] = (attempts[taskId] ?? 0) + 1;
    const runId = `${args.runId}-${taskId}-${attempts[taskId]}`;
    const item = {
      id: task.id,
      title: task.title,
      doneMeans: task.doneMeans,
      leafId: args.leafId,
      context: leafContext(args.leafId),
      ...(task.description ? { description: task.description } : {}),
      ...(task.role ? { role: task.role } : {}),
      ...(task.checks ? { checks: task.checks } : {}),
      ...(args.siblings ? { siblings: args.siblings } : {}),
      ...(attempts[taskId]! > 1 && task.evidence ? { previousAttempt: task.evidence } : {}),
    };
    const input: ProcedureRunInput = {
      ticket: { runId, parentRunId: args.runId, depth: 1, ownerId: args.ownerId, agentSlug: 'executor', trigger: 'agent' },
      procedure: executor.procedure,
      inputs: { item, message: JSON.stringify(item) },
      environment,
    };
    await executeChild(AgentRunWorkflow, { workflowId: runId, args: [input] });
  }

  return claim('failed', `the leaf was still working its tasks after ${MAX_ROUNDS} runs`);
}
