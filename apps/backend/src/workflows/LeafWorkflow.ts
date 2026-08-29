import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  startChild,
  ParentClosePolicy,
  workflowInfo,
} from '@temporalio/workflow';
import type { UpdateLeafArgs } from '../activities/UpdateLeafActivity.js';
import type { ExecuteLeafArgs, ExecuteLeafResult } from '../activities/ExecuteLeafActivity.js';
import type { LeafGateArgs, LeafGateResult, ReleaseDependentsResult } from '../activities/LeafGateActivity.js';
import type { LandRequestArgs, LandRequestResult } from '../activities/LandRequestActivity.js';
import type { ResolveLandingArgs, ResolveLandingResult } from '../activities/ResolveLandingActivity.js';
import type { AcceptRequestArgs, AcceptRequestResult } from '../activities/AcceptRequestActivity.js';
import type { ReplanArgs, ReplanResult } from '../activities/ReplanActivity.js';
import type { JudgeLeafArgs, JudgeLeafResult } from '../activities/JudgeLeafActivity.js';
import { MAX_LEAF_ATTEMPTS } from '../lib/leaves.js';
import { executeLeafActivityMeta, updateLeafActivityMeta, checkLeafGateActivityMeta, releaseDependentsActivityMeta, landRequestActivityMeta, resolveLandingActivityMeta, acceptRequestActivityMeta, replanActivityMeta, judgeLeafActivityMeta,
} from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { UpdateLeafActivity } = proxyActivities<{ UpdateLeafActivity: (args: UpdateLeafArgs) => Promise<void> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: updateLeafActivityMeta.startToCloseTimeout,
});

const { ExecuteLeafActivity } = proxyActivities<{ ExecuteLeafActivity: (args: ExecuteLeafArgs) => Promise<ExecuteLeafResult> }>({
  startToCloseTimeout: executeLeafActivityMeta.startToCloseTimeout,
  heartbeatTimeout: executeLeafActivityMeta.heartbeatTimeout,
  retry: {
    maximumAttempts: MAX_LEAF_ATTEMPTS,
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
  },
});

const { CheckLeafGateActivity } = proxyActivities<{ CheckLeafGateActivity: (args: LeafGateArgs) => Promise<LeafGateResult> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: checkLeafGateActivityMeta.startToCloseTimeout,
});

const { ReleaseDependentsActivity } = proxyActivities<{ ReleaseDependentsActivity: (args: LeafGateArgs) => Promise<ReleaseDependentsResult> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: releaseDependentsActivityMeta.startToCloseTimeout,
});

const { JudgeLeafActivity } = proxyActivities<{ JudgeLeafActivity: (args: JudgeLeafArgs) => Promise<JudgeLeafResult> }>({
  startToCloseTimeout: judgeLeafActivityMeta.startToCloseTimeout,
  retry: { maximumAttempts: 1 },
});

const { LandRequestActivity } = proxyActivities<{ LandRequestActivity: (args: LandRequestArgs) => Promise<LandRequestResult> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: landRequestActivityMeta.startToCloseTimeout,
});

const { ResolveLandingActivity } = proxyActivities<{ ResolveLandingActivity: (args: ResolveLandingArgs) => Promise<ResolveLandingResult> }>({
  startToCloseTimeout: resolveLandingActivityMeta.startToCloseTimeout,
  retry: { maximumAttempts: 1 },
});

const { ReplanActivity } = proxyActivities<{ ReplanActivity: (args: ReplanArgs) => Promise<ReplanResult> }>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: replanActivityMeta.startToCloseTimeout,
});
const { AcceptRequestActivity } = proxyActivities<{ AcceptRequestActivity: (args: AcceptRequestArgs) => Promise<AcceptRequestResult> }>({
  startToCloseTimeout: acceptRequestActivityMeta.startToCloseTimeout,
  retry: { maximumAttempts: 1 },
});

export type WorkflowLeafColumn = 'todo' | 'in-progress' | 'review';
export type WorkflowLeafStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface LeafWorkflowArgs {
  leafId: string;
  title: string;
  column: WorkflowLeafColumn;
  depth: number;
}

export interface ChildRequest {
  leafId: string;
  title: string;
  blocking: boolean;
  index: number;
}

export interface LeafWorkflowState {
  column: WorkflowLeafColumn;
  status: WorkflowLeafStatus;
  blockingChildren: number;
}

export const moveLeafSignal = defineSignal<[WorkflowLeafColumn]>('moveLeaf');
export const completeLeafSignal = defineSignal<[]>('completeLeaf');
export const cancelLeafSignal = defineSignal<[]>('cancelLeaf');
export const addChildSignal = defineSignal<[ChildRequest]>('addChild');
export const dependencyCompletedSignal = defineSignal<[string]>('dependencyCompleted');
export const leafStateQuery = defineQuery<LeafWorkflowState>('leafState');

function describeFailure(err: unknown): string {
  const parts: string[] = [];
  let current: any = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const message = typeof current === 'string' ? current : current?.message;
    if (message && !/^(Child Workflow execution failed|Activity task failed)$/.test(message)) {
      parts.push(String(message));
    }
    current = current?.cause;
  }
  return (parts.join(': ') || String((err as any)?.message ?? err)).slice(0, 2000);
}

export async function LeafWorkflow(args: LeafWorkflowArgs): Promise<LeafWorkflowState> {
  let column: WorkflowLeafColumn = args.column;
  let status: WorkflowLeafStatus = 'running';
  let cancelled = false;
  let complete = false;

  const blockingChildren: Promise<unknown>[] = [];
  const startedChildren = new Set<number>();
  const pending: ChildRequest[] = [];

  setHandler(leafStateQuery, () => ({ column, status, blockingChildren: blockingChildren.length }));

  setHandler(moveLeafSignal, (next) => {
    column = next;
  });

  setHandler(cancelLeafSignal, () => {
    cancelled = true;
  });

  setHandler(completeLeafSignal, () => {
    complete = true;
  });

  function startLeafChild(req: ChildRequest): Promise<unknown> {
    const child = startChild(LeafWorkflow, {
      workflowId: `leaf-${args.leafId}-child-${req.index}`,
      args: [{ leafId: req.leafId, title: req.title, column: 'todo', depth: args.depth + 1 }],
      parentClosePolicy: req.blocking ? ParentClosePolicy.TERMINATE : ParentClosePolicy.ABANDON,
    });
    return child.then((handle) => handle.result());
  }

  setHandler(addChildSignal, (req) => {
    if (startedChildren.has(req.index)) return;
    startedChildren.add(req.index);
    pending.push(req);
  });

  await UpdateLeafActivity({ leafId: args.leafId, workflowId: workflowInfo().workflowId });

  let dependencyFinished = false;
  setHandler(dependencyCompletedSignal, () => {
    dependencyFinished = true;
  });

  let gate = await CheckLeafGateActivity({ leafId: args.leafId });
  if (gate.decision === 'stop') return { column, status: 'cancelled', blockingChildren: 0 };

  while (gate.decision === 'wait' && !cancelled) {
    await condition(() => cancelled || dependencyFinished);
    if (cancelled) break;
    dependencyFinished = false;
    gate = await CheckLeafGateActivity({ leafId: args.leafId });
    if (gate.decision === 'stop') return { column, status: 'cancelled', blockingChildren: 0 };
  }

  if (gate.decision === 'abandon') {
    await UpdateLeafActivity({ leafId: args.leafId, status: 'cancelled' });
    await ReleaseDependentsActivity({ leafId: args.leafId });
    return { column, status: 'cancelled', blockingChildren: 0 };
  }

  if (cancelled) {
    await UpdateLeafActivity({ leafId: args.leafId, status: 'cancelled' });
    await ReleaseDependentsActivity({ leafId: args.leafId });
    return { column, status: 'cancelled', blockingChildren: 0 };
  }

  await UpdateLeafActivity({ leafId: args.leafId, status: 'running' });

  let ownWorkFailed: unknown;
  const ownWork = ExecuteLeafActivity({ leafId: args.leafId })
    .then(() => {
      complete = true;
    })
    .catch((err) => {
      ownWorkFailed = err;
      complete = true;
    });

  for (;;) {
    await condition(() => cancelled || complete || pending.length > 0);
    while (pending.length > 0) {
      const req = pending.shift()!;
      const run = startLeafChild(req);
      if (req.blocking) blockingChildren.push(run);
      else run.catch(() => {});
    }
    if (cancelled || complete) break;
  }

  if (cancelled) {
    status = 'cancelled';
    await UpdateLeafActivity({ leafId: args.leafId, status });
    await ReleaseDependentsActivity({ leafId: args.leafId });
    await LandRequestActivity({ leafId: args.leafId });
    return { column, status, blockingChildren: blockingChildren.length };
  }

  await ownWork;
  if (ownWorkFailed) {
    status = 'failed';
    await UpdateLeafActivity({ leafId: args.leafId, status });
    await ReleaseDependentsActivity({ leafId: args.leafId });
    await LandRequestActivity({ leafId: args.leafId });
    return { column, status, blockingChildren: blockingChildren.length };
  }

  if (blockingChildren.length > 0) {
    const results = await Promise.allSettled(blockingChildren);
    if (results.some((r) => r.status === 'rejected')) {
      status = 'failed';
      await UpdateLeafActivity({ leafId: args.leafId, status });
      await ReleaseDependentsActivity({ leafId: args.leafId });
      await LandRequestActivity({ leafId: args.leafId });
      return { column, status, blockingChildren: blockingChildren.length };
    }
  }

  status = 'succeeded';
  column = 'review';
  await UpdateLeafActivity({ leafId: args.leafId, status, column });
  await ReleaseDependentsActivity({ leafId: args.leafId });
  await JudgeLeafActivity({ leafId: args.leafId }).catch(() => undefined);

  const landing = await LandRequestActivity({ leafId: args.leafId });
  if (landing.stuck.length > 0) await ResolveLandingActivity({ leafId: args.leafId });
  await AcceptRequestActivity({ leafId: args.leafId });
  await ReplanActivity({ leafId: args.leafId });
  return { column, status, blockingChildren: blockingChildren.length };
}
