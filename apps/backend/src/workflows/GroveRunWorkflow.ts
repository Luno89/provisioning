import { ApplicationFailure, defineSignal, getExternalWorkflowHandle, proxyActivities, setHandler, startChild, workflowInfo } from '@temporalio/workflow';
import type { Procedure } from '@koala/agent-engine/procedure';
import { AgentRunWorkflow, cancelSignal } from './AgentRunWorkflow.js';
import { GroveLeafWorkflow, cancelLeafSignal } from './GroveLeafWorkflow.js';
import { GROVE_CANCEL_LEAF, GROVE_STOP_RUN } from '../engine-host/temporal/contracts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import type { TreeSandbox } from '../engine-host/sandboxes/tree-workspaces.js';
import { judgeCheckout, leafBriefPath, leafContext, leafWorktree } from '../lib/plan-documents.js';

const LEAVES_AT_ONCE = 3;

const runPrefix = (): string => {
  const info = workflowInfo();
  return `${info.workflowId}-${info.runId.slice(0, 8)}`;
};
import type {
  GrovePartition,
  GrovePartitionArgs,
  GrovePartitionLeaf,
  GroveStages,
  GroveWorkspaceArgs,
  GroveTreeArgs,
  GroveLeafNeedingPlan,
  ResolveAgentArgs,
  ResolvedAgentInfo,
  GroveJudgeCheckoutArgs,
  GroveJudgeCheckouts,
  GroveCheckClaimsArgs,
  GroveCheckedClaims,
  GrovePrepareWorkArgs,
  GrovePreparedWork,
  GroveRunArgs,
  GroveRunResult,
  ProcedureRunInput,
  RunTicket,
} from '../engine-host/temporal/contracts.js';

/** Hard cap on the pass loop: a tree still moving after this many passes is reported, not spun up. */
const MAX_PASSES_DEFAULT = 24;

export const stopRunSignal = defineSignal<[]>(GROVE_STOP_RUN);
export const cancelLeafInRunSignal = defineSignal<[string]>(GROVE_CANCEL_LEAF);

interface RunControl {
  stopping: boolean;
  cancelledLeaves: Set<string>;
  leafRuns: Map<string, string>;
  agentRuns: Set<string>;
}

const signalQuietly = (workflowId: string, signal: typeof cancelSignal | typeof cancelLeafSignal): void => {
  void getExternalWorkflowHandle(workflowId).signal(signal).catch(() => undefined);
};

async function runAgent(control: RunControl, runId: string, input: ProcedureRunInput) {
  const child = await startChild(AgentRunWorkflow, { workflowId: runId, args: [input] });
  control.agentRuns.add(runId);
  if (control.stopping) await child.signal(cancelSignal);
  return child.result().finally(() => control.agentRuns.delete(runId));
}

const { GrovePartitionActivity } = proxyActivities<{
  GrovePartitionActivity(args: GrovePartitionArgs): Promise<GrovePartition>;
}>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '30 seconds',
});

const {
  GroveWorkspaceActivity, GroveParkWorkspaceActivity, GrovePrepareWorkActivity, GroveJudgeCheckoutActivity,
  GroveCheckClaimsActivity, GroveNeedsPlanActivity, GroveOpenProposalsActivity, GroveResetInFlightActivity,
  GroveStagesActivity, EngineResolveAgentActivity,
} = proxyActivities<{
  GroveResetInFlightActivity(args: GroveTreeArgs): Promise<string[]>;
  GroveStagesActivity(args: GroveTreeArgs): Promise<GroveStages>;
  GroveWorkspaceActivity(args: GroveWorkspaceArgs): Promise<TreeSandbox>;
  GroveParkWorkspaceActivity(args: GroveWorkspaceArgs): Promise<void>;
  GrovePrepareWorkActivity(args: GrovePrepareWorkArgs): Promise<GrovePreparedWork>;
  GroveJudgeCheckoutActivity(args: GroveJudgeCheckoutArgs): Promise<GroveJudgeCheckouts>;
  GroveCheckClaimsActivity(args: GroveCheckClaimsArgs): Promise<GroveCheckedClaims>;
  GroveNeedsPlanActivity(args: GroveTreeArgs): Promise<GroveLeafNeedingPlan[]>;
  GroveOpenProposalsActivity(args: GroveTreeArgs): Promise<string[]>;
  EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo>;
}>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '10 minutes',
});

/**
 * The grove run — the tree-level loop that the pass procedures were built for.
 *
 * It IS the activity loop (the pass loop, host-side, deterministic): partition
 * the tree; work every ready leaf as its own GroveLeafWorkflow (one run of the
 * agent the tree's type names for the work stage, then the claim);
 * judge every fresh claim in its own run of the agent it names for the judge
 * stage — once the checks its tasks carry have been run, because what code can
 * settle, code settles; re-partition; until the tree is quiet or the pass cap is
 * reached.
 * A type that names no agents gets the defaults.
 *
 * Reading the partition as an activity and the passes as child workflows keeps
 * each segment small and durable: a crash between passes redoes scheduling and
 * gets handed to the judge, not back into the work; a crash inside a pass
 * replays the pass, and because a settled claim is no longer claimed, the
 * re-judge only reaches claims that are actually still open.
 */
export async function GroveRunWorkflow(args: GroveRunArgs): Promise<GroveRunResult> {
  const control: RunControl = { stopping: false, cancelledLeaves: new Set(), leafRuns: new Map(), agentRuns: new Set() };
  setHandler(stopRunSignal, () => {
    control.stopping = true;
    for (const runId of control.leafRuns.values()) signalQuietly(runId, cancelLeafSignal);
    for (const runId of control.agentRuns) signalQuietly(runId, cancelSignal);
  });
  setHandler(cancelLeafInRunSignal, (leafId) => {
    control.cancelledLeaves.add(leafId);
    const runId = control.leafRuns.get(leafId);
    if (runId) signalQuietly(runId, cancelLeafSignal);
  });

  const workspace = { treeId: args.treeId, ownerId: args.ownerId };
  const environment = await GroveWorkspaceActivity(workspace);
  await GroveResetInFlightActivity(workspace);
  try {
    return await passUntilQuiet(args, environment, control);
  } finally {
    await GroveParkWorkspaceActivity(workspace);
  }
}

async function passUntilQuiet(args: GroveRunArgs, environment: TreeSandbox, control: RunControl): Promise<GroveRunResult> {
  const maxPasses = args.maxPasses ?? MAX_PASSES_DEFAULT;
  const stages = await GroveStagesActivity({ treeId: args.treeId, ownerId: args.ownerId });
  let passes = 0;
  const stopped = async (awaitingReview: string[]): Promise<GroveRunResult> => ({
    treeId: args.treeId, outcome: 'stopped', passes, awaitingReview,
    awaitingApproval: await GroveOpenProposalsActivity({ treeId: args.treeId, ownerId: args.ownerId }),
  });

  for (;;) {
    let partition = await GrovePartitionActivity({ treeId: args.treeId, ownerId: args.ownerId });

    const awaitingReview = partition.awaitingReview.map((leaf) => leaf.id);
    if (control.stopping) return stopped(awaitingReview);
    if (partition.ready.length === 0 && partition.claimed.length === 0) {
      await proposeLeafPlans(args, environment, control, stages.plan);
      if (control.stopping) return stopped(awaitingReview);
      const awaitingApproval = await GroveOpenProposalsActivity({ treeId: args.treeId, ownerId: args.ownerId });
      return { treeId: args.treeId, outcome: 'quiet', passes, awaitingReview, awaitingApproval };
    }
    if (passes >= maxPasses) {
      const awaitingApproval = await GroveOpenProposalsActivity({ treeId: args.treeId, ownerId: args.ownerId });
      return { treeId: args.treeId, outcome: 'capped', passes, awaitingReview, awaitingApproval };
    }

    passes += 1;

    const prepared = partition.ready.length > 0
      ? await GrovePrepareWorkActivity({ treeId: args.treeId, ownerId: args.ownerId, leafIds: partition.ready.map((leaf) => leaf.id) })
      : { ready: [], failed: [] };
    const workable = partition.ready.filter((leaf) => prepared.ready.includes(leaf.id));

    if (partition.ready.length > 0) {
      await workLeaves(args, environment, passes, workable, control, stages.work);
      if (control.stopping) return stopped(awaitingReview);
      // The work pass files fresh claims; the judge pass must see them, so read the tree again.
      partition = await GrovePartitionActivity({ treeId: args.treeId, ownerId: args.ownerId });
    }
    if (partition.claimed.length > 0) {
      const leafIds = partition.claimed.map((leaf) => leaf.id);
      const checkouts = await GroveJudgeCheckoutActivity({ treeId: args.treeId, ownerId: args.ownerId, leafIds });
      // What code can settle, code settles: a claim whose checks fail is failed here, with the report
      // as its reason, and its leaf goes back to be replanned. Only the rest reach the judge.
      const checked = await GroveCheckClaimsActivity({ treeId: args.treeId, ownerId: args.ownerId, leafIds, checkouts });
      const claims = partition.claimed.filter((leaf) => !(leaf.id in checked.settled));

      if (claims.length > 0) {
        const judge = await EngineResolveAgentActivity({ ownerId: args.ownerId, agentSlug: stages.judge });
        if (!judge.found || !judge.procedure) {
          // Non-retryable: a retry would re-work the tree's leaves and fail here again, forever.
          throw ApplicationFailure.nonRetryable(
            `there is no agent called "${stages.judge}" with a procedure to judge this tree's leaves`,
            'GroveJudgeMissing',
          );
        }
        await runGrovePass({
          args,
          environment,
          control,
          pass: passes,
          procedure: judge.procedure,
          agentSlug: stages.judge,
          role: 'judge',
          inputs: { claimed: claimItems(claims, args.treeId, checkouts) },
        });
      }
    }
  }
}

async function proposeLeafPlans(args: GroveRunArgs, environment: TreeSandbox, control: RunControl, planner: string): Promise<void> {
  const needs = await GroveNeedsPlanActivity({ treeId: args.treeId, ownerId: args.ownerId });
  if (needs.length === 0) return;
  const resolved = await EngineResolveAgentActivity({ ownerId: args.ownerId, agentSlug: planner });
  if (!resolved.found || !resolved.procedure) {
    // Non-retryable, and not silent either: leaves are waiting to be planned, so a "quiet" run would hide a broken type.
    throw ApplicationFailure.nonRetryable(
      `there is no agent called "${planner}" with a procedure to plan this tree's leaves`,
      'GrovePlannerMissing',
    );
  }
  await GrovePrepareWorkActivity({ treeId: args.treeId, ownerId: args.ownerId, leafIds: needs.map((need) => need.leafId) });

  const run = runPrefix();
  for (let offset = 0; offset < needs.length; offset += LEAVES_AT_ONCE) {
    await Promise.all(needs.slice(offset, offset + LEAVES_AT_ONCE).map((need) => {
      const runId = `${run}-plan-${need.leafId}`;
      const inputs = {
        treeId: args.treeId,
        leafId: need.leafId,
        leafTitle: need.leafTitle,
        leafBody: need.leafBody,
        leafBrief: leafBriefPath(need.leafId),
        mode: need.mode,
        ...(need.failure ? { failure: need.failure } : {}),
      };
      const goal = `${need.mode === 'replan' ? 'Replan' : 'Break down'} the leaf "${need.leafTitle}".`;
      const input: ProcedureRunInput = {
        ticket: { runId, depth: 0, ownerId: args.ownerId, agentSlug: planner, trigger: 'user' },
        procedure: resolved.procedure!,
        // The goal is the opening line; the engine labels the rest of what the planner is given.
        inputs: { ...inputs, goal, message: goal },
        environment: { ...environment, worktree: leafWorktree(need.leafId) },
      };
      return control.stopping ? undefined : runAgent(control, runId, input);
    }));
  }
}

async function workLeaves(args: GroveRunArgs, environment: TreeSandbox, pass: number, leaves: GrovePartitionLeaf[], control: RunControl, workAgent: string): Promise<void> {
  const run = runPrefix();
  for (let offset = 0; offset < leaves.length; offset += LEAVES_AT_ONCE) {
    if (control.stopping) return;
    await Promise.all(leaves.slice(offset, offset + LEAVES_AT_ONCE).map(async (leaf) => {
      if (control.cancelledLeaves.has(leaf.id)) return;
      const runId = `${run}-p${pass}-leaf-${leaf.id}`;
      const child = await startChild(GroveLeafWorkflow, {
        workflowId: runId,
        args: [{
          treeId: args.treeId,
          ownerId: args.ownerId,
          leafId: leaf.id,
          leafTitle: leaf.title,
          leafBody: leaf.body,
          runId,
          environment,
          workAgent,
          ...(leaves.length > 1
            ? { siblings: `${leaves.length - 1} other leaves of this tree are being worked at the same time, each in its own worktree — keep to ${leaf.title}.` }
            : {}),
        }],
      });
      control.leafRuns.set(leaf.id, runId);
      if (control.stopping || control.cancelledLeaves.has(leaf.id)) await child.signal(cancelLeafSignal);
      await child.result().finally(() => control.leafRuns.delete(leaf.id));
    }));
  }
}

/** The fan-out item the judge children receive — the leaf and the claim that is against it. */
function claimItems(claimed: GrovePartition['claimed'], treeId: string, checkouts: GroveJudgeCheckouts): Record<string, unknown>[] {
  return claimed.map((leaf) => {
    const commit = checkouts[leaf.id];
    const worktree = commit ? judgeCheckout(leaf.id) : leafWorktree(leaf.id);
    return {
      leafId: leaf.id,
      leafTitle: leaf.title,
      leafBody: leaf.body,
      treeId,
      branchId: leaf.branchId,
      worktree,
      context: { ...leafContext(leaf.id), worktree, ...(commit ? { commit } : {}) },
      ...(leaf.claim ? { claim: leaf.claim } : {}),
    };
  });
}

/** One pass: one child engine run of the agent the tree names for it. A failed pass fails the run, rather than being retried into more work. */
async function runGrovePass(options: {
  args: GroveRunArgs;
  environment: TreeSandbox;
  control: RunControl;
  pass: number;
  procedure: Procedure;
  /** the agent whose procedure this pass runs — the tree's type may name its own */
  agentSlug: string;
  role: 'judge';
  inputs: Record<string, unknown>;
}): Promise<void> {
  const runId = `${runPrefix()}-p${options.pass}-${options.role}`;
  const ticket: RunTicket = {
    runId,
    depth: 0,
    ownerId: options.args.ownerId,
    agentSlug: options.agentSlug,
    trigger: 'user',
  };
  const input: ProcedureRunInput = { ticket, procedure: options.procedure, inputs: options.inputs, environment: options.environment };

  if (options.control.stopping) return;
  const child = await runAgent(options.control, runId, input);
  if (options.control.stopping) return;
  if (child.outcome !== 'ok') {
    // Non-retryable: a retry would re-work the tree's leaves and meet the same failed pass again.
    throw ApplicationFailure.nonRetryable(
      `grove ${options.role} pass failed: ${child.reason ?? 'no reason given'}`,
      'GrovePassFailed',
    );
  }
}
