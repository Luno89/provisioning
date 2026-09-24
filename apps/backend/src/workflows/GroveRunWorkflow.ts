import { proxyActivities, executeChild } from '@temporalio/workflow';
import { GROVE_JUDGE_PASS, GROVE_WORK_PASS, type Procedure } from '@koala/agent-engine/procedure';
import { AgentRunWorkflow } from './AgentRunWorkflow.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import type { TreeSandbox } from '../engine-host/sandboxes/tree-workspaces.js';
import type {
  GrovePartition,
  GrovePartitionArgs,
  GrovePartitionLeaf,
  GroveWorkspaceArgs,
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

const { GroveWorkspaceActivity, GroveParkWorkspaceActivity } = proxyActivities<{
  GroveWorkspaceActivity(args: GroveWorkspaceArgs): Promise<TreeSandbox>;
  GroveParkWorkspaceActivity(args: GroveWorkspaceArgs): Promise<void>;
}>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '10 minutes',
});

/**
 * The grove run — the tree-level loop that the pass procedures were built for.
 *
 * It IS the activity loop (the pass loop, host-side, deterministic): partition
 * the tree; work every ready leaf in one fan-out (grove-work-pass, a child
 * engine run); judge every fresh claim in its own run (grove-judge-pass);
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
    let partition = await GrovePartitionActivity({ treeId: args.treeId });

    if (partition.ready.length === 0 && partition.claimed.length === 0) {
      return { treeId: args.treeId, outcome: 'quiet', passes };
    }
    if (passes >= maxPasses) {
      return { treeId: args.treeId, outcome: 'capped', passes };
    }

    passes += 1;

    if (partition.ready.length > 0) {
      await runGrovePass({
        args,
        environment,
        pass: passes,
        procedure: GROVE_WORK_PASS,
        role: 'work',
        inputs: { ready: workItems(partition.ready, args.treeId) },
      });
      // The work pass files fresh claims; the judge pass must see them, so read the tree again.
      partition = await GrovePartitionActivity({ treeId: args.treeId });
    }
    if (partition.claimed.length > 0) {
      await runGrovePass({
        args,
        environment,
        pass: passes,
        procedure: GROVE_JUDGE_PASS,
        role: 'judge',
        inputs: { claimed: claimItems(partition.claimed, args.treeId) },
      });
    }
  }
}

/** The fan-out item the pass children receive — the leaf the child owns, and who else is working on the same tree. */
function workItems(ready: GrovePartitionLeaf[], treeId: string): Record<string, unknown>[] {
  return ready.map((leaf) => ({
    leafId: leaf.id,
    leafTitle: leaf.title,
    leafBody: leaf.body,
    treeId,
    branchId: leaf.branchId,
    ...(ready.length > 1
      ? { siblings: `${ready.length - 1} other leaves are working in this tree at the same time — stay inside ${leaf.title}.` }
      : {}),
  }));
}

/** The fan-out item the judge children receive — the leaf and the claim that is against it. */
function claimItems(claimed: GrovePartition['claimed'], treeId: string): Record<string, unknown>[] {
  return claimed.map((leaf) => ({
    leafId: leaf.id,
    leafTitle: leaf.title,
    leafBody: leaf.body,
    treeId,
    branchId: leaf.branchId,
    ...(leaf.claim ? { claim: leaf.claim } : {}),
  }));
}

/** One pass: one child engine run of the pass procedure; a failed pass fails the run (the loop resumes at the next partition). */
async function runGrovePass(options: {
  args: GroveRunArgs;
  environment: TreeSandbox;
  pass: number;
  procedure: Procedure;
  role: 'work' | 'judge';
  inputs: Record<string, unknown>;
}): Promise<void> {
  const runId = `grove-${options.args.treeId}-p${options.pass}-${options.role}`;
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