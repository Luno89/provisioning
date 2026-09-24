import { proxyActivities, executeChild, workflowInfo } from '@temporalio/workflow';
import { GROVE_JUDGE_PASS, type Procedure } from '@koala/agent-engine/procedure';
import { AgentRunWorkflow } from './AgentRunWorkflow.js';
import { GroveLeafWorkflow } from './GroveLeafWorkflow.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import type { TreeSandbox } from '../engine-host/sandboxes/tree-workspaces.js';
import { judgeCheckout, leafContext, leafWorktree } from '../lib/plan-documents.js';

const LEAVES_AT_ONCE = 3;
import type {
  GrovePartition,
  GrovePartitionArgs,
  GrovePartitionLeaf,
  GroveWorkspaceArgs,
  GroveJudgeCheckoutArgs,
  GroveJudgeCheckouts,
  GrovePrepareWorkArgs,
  GrovePreparedWork,
  GroveRunArgs,
  GroveRunResult,
  ProcedureRunInput,
  RunTicket,
} from '../engine-host/temporal/contracts.js';

/** Hard cap on the pass loop: a tree still moving after this many passes is reported, not spun up. */
const MAX_PASSES_DEFAULT = 24;

const { GrovePartitionActivity } = proxyActivities<{
  GrovePartitionActivity(args: GrovePartitionArgs): Promise<GrovePartition>;
}>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '30 seconds',
});

const { GroveWorkspaceActivity, GroveParkWorkspaceActivity, GrovePrepareWorkActivity, GroveJudgeCheckoutActivity } = proxyActivities<{
  GroveWorkspaceActivity(args: GroveWorkspaceArgs): Promise<TreeSandbox>;
  GroveParkWorkspaceActivity(args: GroveWorkspaceArgs): Promise<void>;
  GrovePrepareWorkActivity(args: GrovePrepareWorkArgs): Promise<GrovePreparedWork>;
  GroveJudgeCheckoutActivity(args: GroveJudgeCheckoutArgs): Promise<GroveJudgeCheckouts>;
}>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '10 minutes',
});

/**
 * The grove run — the tree-level loop that the pass procedures were built for.
 *
 * It IS the activity loop (the pass loop, host-side, deterministic): partition
 * the tree; work every ready leaf as its own GroveLeafWorkflow (its tasks
 * through the executor, then the claim, all by code); judge every fresh claim
 * in its own run (grove-judge-pass);
 * re-partition; until the tree is quiet or the pass cap is reached.
 *
 * Reading the partition as an activity and the passes as child workflows keeps
 * each segment small and durable: a crash between passes redoes scheduling and
 * gets handed to the judge, not back into the work; a crash inside a pass
 * replays the pass, and because a settled claim is no longer claimed, the
 * re-judge only reaches claims that are actually still open.
 */
export async function GroveRunWorkflow(args: GroveRunArgs): Promise<GroveRunResult> {
  const workspace = { treeId: args.treeId, ownerId: args.ownerId };
  const environment = await GroveWorkspaceActivity(workspace);
  try {
    return await passUntilQuiet(args, environment);
  } finally {
    await GroveParkWorkspaceActivity(workspace);
  }
}

async function passUntilQuiet(args: GroveRunArgs, environment: TreeSandbox): Promise<GroveRunResult> {
  const maxPasses = args.maxPasses ?? MAX_PASSES_DEFAULT;
  let passes = 0;

  for (;;) {
    let partition = await GrovePartitionActivity({ treeId: args.treeId, ownerId: args.ownerId });

    const awaitingReview = partition.awaitingReview.map((leaf) => leaf.id);
    if (partition.ready.length === 0 && partition.claimed.length === 0) {
      return { treeId: args.treeId, outcome: 'quiet', passes, awaitingReview };
    }
    if (passes >= maxPasses) {
      return { treeId: args.treeId, outcome: 'capped', passes, awaitingReview };
    }

    passes += 1;

    const prepared = partition.ready.length > 0
      ? await GrovePrepareWorkActivity({ treeId: args.treeId, ownerId: args.ownerId, leafIds: partition.ready.map((leaf) => leaf.id) })
      : { ready: [], failed: [] };
    const workable = partition.ready.filter((leaf) => prepared.ready.includes(leaf.id));

    if (partition.ready.length > 0) {
      await workLeaves(args, environment, passes, workable);
      // The work pass files fresh claims; the judge pass must see them, so read the tree again.
      partition = await GrovePartitionActivity({ treeId: args.treeId, ownerId: args.ownerId });
    }
    if (partition.claimed.length > 0) {
      const checkouts = await GroveJudgeCheckoutActivity({ treeId: args.treeId, ownerId: args.ownerId, leafIds: partition.claimed.map((leaf) => leaf.id) });
      await runGrovePass({
        args,
        environment,
        pass: passes,
        procedure: GROVE_JUDGE_PASS,
        role: 'judge',
        inputs: { claimed: claimItems(partition.claimed, args.treeId, checkouts) },
      });
    }
  }
}

async function workLeaves(args: GroveRunArgs, environment: TreeSandbox, pass: number, leaves: GrovePartitionLeaf[]): Promise<void> {
  const run = workflowInfo().workflowId;
  for (let offset = 0; offset < leaves.length; offset += LEAVES_AT_ONCE) {
    await Promise.all(leaves.slice(offset, offset + LEAVES_AT_ONCE).map((leaf) => {
      const runId = `${run}-p${pass}-leaf-${leaf.id}`;
      return executeChild(GroveLeafWorkflow, {
        workflowId: runId,
        args: [{
          treeId: args.treeId,
          ownerId: args.ownerId,
          leafId: leaf.id,
          leafTitle: leaf.title,
          runId,
          environment,
          ...(leaves.length > 1
            ? { siblings: `${leaves.length - 1} other leaves of this tree are being worked at the same time, each in its own worktree — keep to ${leaf.title}.` }
            : {}),
        }],
      });
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

/** One pass: one child engine run of the pass procedure; a failed pass fails the run (the loop resumes at the next partition). */
async function runGrovePass(options: {
  args: GroveRunArgs;
  environment: TreeSandbox;
  pass: number;
  procedure: Procedure;
  role: 'judge';
  inputs: Record<string, unknown>;
}): Promise<void> {
  const runId = `${workflowInfo().workflowId}-p${options.pass}-${options.role}`;
  const ticket: RunTicket = {
    runId,
    depth: 0,
    ownerId: options.args.ownerId,
    agentSlug: 'grove-runner',
    trigger: 'user',
  };
  const input: ProcedureRunInput = { ticket, procedure: options.procedure, inputs: options.inputs, environment: options.environment };

  const child = await executeChild(AgentRunWorkflow, { workflowId: runId, args: [input] });
  if (child.outcome !== 'ok') {
    throw new Error(`grove ${options.role} pass failed: ${child.reason ?? 'no reason given'}`);
  }
}