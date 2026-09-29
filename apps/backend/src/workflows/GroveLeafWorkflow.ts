import { defineSignal, getExternalWorkflowHandle, proxyActivities, setHandler, startChild } from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import { DEFAULT_STAGES } from '../lib/grove-stages.js';
import { leafWorktree } from '../lib/plan-documents.js';
import { AgentRunWorkflow, cancelSignal } from './AgentRunWorkflow.js';
import { GROVE_CANCEL_LEAF } from '../engine-host/temporal/contracts.js';
import type {
  GroveClaimArgs,
  GroveClaimOutcome,
  GroveLeafArgs,
  GroveLeafResult,
  GroveLeafStatusArgs,
  ProcedureRunInput,
  ResolveAgentArgs,
  ResolvedAgentInfo,
} from '../engine-host/temporal/contracts.js';

const { GroveLeafStatusActivity, GroveClaimActivity, EngineResolveAgentActivity } = proxyActivities<{
  GroveLeafStatusActivity(args: GroveLeafStatusArgs): Promise<boolean>;
  GroveClaimActivity(args: GroveClaimArgs): Promise<GroveClaimOutcome>;
  EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo>;
}>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '5 minutes',
});

export const cancelLeafSignal = defineSignal<[]>(GROVE_CANCEL_LEAF);

/**
 * One leaf, worked end to end by the agent its tree's type names for the work stage.
 *
 * What is left here is what is not the work: the leaf's status, the claim, and stopping. The agent runs its own
 * procedure — `grove-work-leaf` by default — which asks `next_leaf_task` what the leaf needs, hands each task to an
 * executor of its own, and asks again, so the leaf stops when the run does. The run's three endings are the leaf's
 * three: `ok` claims it, `failed` claims against it with the reason the run gave, and `refused` (no tasks yet) puts it
 * back for the planner. There is no round cap here — the limit on the loop is whatever budget the procedure carries.
 */
export async function GroveLeafWorkflow(args: GroveLeafArgs): Promise<GroveLeafResult> {
  let cancelled = false;
  let working: string | undefined;
  setHandler(cancelLeafSignal, () => {
    cancelled = true;
    if (working) void getExternalWorkflowHandle(working).signal(cancelSignal).catch(() => undefined);
  });
  const stopped = async (): Promise<GroveLeafResult> => {
    await GroveLeafStatusActivity({ ownerId: args.ownerId, leafId: args.leafId, from: ['running'], to: 'pending' });
    return { leafId: args.leafId, outcome: 'cancelled', reason: 'the leaf was stopped before it finished' };
  };
  const started = await GroveLeafStatusActivity({ ownerId: args.ownerId, leafId: args.leafId, from: ['pending'], to: 'running' });
  if (!started) return { leafId: args.leafId, outcome: 'cancelled', reason: 'the leaf was no longer waiting to be worked' };

  const claim = async (result: 'claimed' | 'failed', reason?: string): Promise<GroveLeafResult> => {
    const filed = await GroveClaimActivity({ treeId: args.treeId, ownerId: args.ownerId, leafId: args.leafId, result, ...(reason ? { reason } : {}) });
    if (!filed.ok) return { leafId: args.leafId, outcome: 'failed', reason: `the claim was refused: ${filed.digest}` };
    return { leafId: args.leafId, outcome: result, ...(reason ? { reason } : {}) };
  };
  const backToThePlanner = async (): Promise<GroveLeafResult> => {
    await GroveLeafStatusActivity({ ownerId: args.ownerId, leafId: args.leafId, from: ['running'], to: 'pending' });
    return { leafId: args.leafId, outcome: 'unbroken' };
  };

  const agentSlug = args.workAgent || DEFAULT_STAGES.work;
  const worker = await EngineResolveAgentActivity({ ownerId: args.ownerId, agentSlug });
  if (!worker.found || !worker.procedure) {
    return claim('failed', `there is no agent called "${agentSlug}" with a procedure to work this leaf`);
  }

  const worktree = leafWorktree(args.leafId);
  const environment = args.environment.kind === 'sandbox' ? { ...args.environment, worktree } : args.environment;
  const runId = `${args.runId}-work`;
  const input: ProcedureRunInput = {
    ticket: { runId, parentRunId: args.runId, depth: 1, ownerId: args.ownerId, agentSlug, trigger: 'agent' },
    procedure: worker.procedure,
    inputs: {
      leafId: args.leafId,
      siblings: args.siblings ?? '',
      message: `Work every task of the leaf "${args.leafTitle}".`,
    },
    environment,
  };

  if (cancelled) return stopped();
  const child = await startChild(AgentRunWorkflow, { workflowId: runId, args: [input] });
  working = runId;
  if (cancelled) await child.signal(cancelSignal);
  const result = await child.result().finally(() => { working = undefined; });
  if (cancelled) return stopped();

  if (result.outcome === 'ok') return claim('claimed');
  if (result.outcome === 'refused') return backToThePlanner();
  return claim('failed', result.reason ?? `the ${agentSlug} run did not finish this leaf`);
}
