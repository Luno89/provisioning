import type { Database } from './db-interface.js';
import type { Leaf, LeafAttempt } from './leaves.js';
import { statusAfterFailure, MAX_LEAF_ATTEMPTS, barrenStreak } from './leaves.js';
import { redactSecrets } from './redact.js';
import { buildFailureNotice, withNotice } from './branch-notice.js';

export interface RecordFailureDeps {
  db: Pick<Database, 'saveLeaf'>;
  currentLeaf: () => Promise<Leaf | undefined>;
}

export interface RecordFailureParams {
  attemptNumber: number;
  priorFailures: LeafAttempt[];
  errMessage: string;
  produced: boolean;
  diagnosis: string | undefined;
  secretsInPlay: () => (string | undefined)[];
}

export async function recordLeafFailure(
  deps: RecordFailureDeps,
  params: RecordFailureParams,
): Promise<{ attempts: LeafAttempt[]; latest: Leaf | undefined }> {
  const attempts: LeafAttempt[] = [
    ...params.priorFailures,
    {
      attempt: Math.max(0, params.attemptNumber - 1),
      error: redactSecrets(params.errMessage.slice(0, 2000), params.secretsInPlay()),
      failedAt: new Date().toISOString(),
      produced: params.produced,
    },
  ];

  const latest = await deps.currentLeaf();
  if (latest) {
    await deps.db.saveLeaf({
      ...latest,
      attempts,
      status: statusAfterFailure(params.attemptNumber, MAX_LEAF_ATTEMPTS),
      ...(params.diagnosis ? { summary: redactSecrets(params.diagnosis.slice(0, 8000), params.secretsInPlay()) } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  return { attempts, latest };
}

export interface NotifyFailureDeps {
  db: Pick<Database, 'getBranches' | 'saveBranch'>;
}

export interface NotifyFailureParams {
  leafId: string;
  branchId: string;
  leafTitle: string;
  errMessage: string;
  attemptCount: number;
}

export async function notifyLeafFailure(deps: NotifyFailureDeps, params: NotifyFailureParams): Promise<void> {
  try {
    const branch = (await deps.db.getBranches()).find((b) => b.id === params.branchId);
    if (!branch) return;
    await deps.db.saveBranch(withNotice(branch, buildFailureNotice(
      params.leafTitle, params.errMessage, params.attemptCount, MAX_LEAF_ATTEMPTS,
    )));
  } catch (err) {
    console.warn(`[leaf-run-failure] could not report the failure of ${params.leafId}: ${(err as Error).message}`);
  }
}

export type RetryDecision =
  | { kind: 'retry' }
  | { kind: 'nonRetryable'; type: 'SelfDiagnosedStop' | 'NoProgress'; message: string };

export function retryDecisionFor(params: {
  errMessage: string;
  selfDiagnosed: 'circling' | 'thrashing' | 'silent' | undefined;
  produced: boolean;
  priorFailures: LeafAttempt[];
}): RetryDecision {
  if (params.selfDiagnosed) {
    const label = params.selfDiagnosed === 'circling'
      ? 'going in circles'
      : params.selfDiagnosed === 'thrashing'
        ? 'producing nothing'
        : 'having stopped calling tools';
    return {
      kind: 'nonRetryable',
      type: 'SelfDiagnosedStop',
      message: `${params.errMessage}\n\n`
        + `The run diagnosed itself as ${label}. `
        + 'Another identical attempt reproduces it rather than fixing it — this needs the task, the '
        + 'tools or the environment changed, which is what POST /api/leaves/:id/review is for.',
    };
  }

  if (barrenStreak(params.priorFailures, params.produced)) {
    return {
      kind: 'nonRetryable',
      type: 'NoProgress',
      message: `${params.errMessage}\n\n`
        + 'Stopped after two attempts that produced no commits and no written output. '
        + 'This is usually something the agent cannot see rather than something more time fixes — '
        + 'check the task, the persona\'s tools, and whether the repository has what it needs.',
    };
  }

  return { kind: 'retry' };
}
