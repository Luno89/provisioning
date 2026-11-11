import type { WorkflowRun } from './workflows.js';

export type ClosedAs = 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TERMINATED' | 'TIMED_OUT' | 'CONTINUED_AS_NEW' | 'NOT_FOUND' | 'RUNNING';

const named = (err: unknown, ...names: string[]): boolean => names.includes((err as { name?: string } | undefined)?.name ?? '');

export const NOT_IN_TEMPORAL = 'Temporal no longer has its workflow, so how it ended cannot be read';

const innermost = (err: unknown): string => {
  let at = err as { message?: string; cause?: unknown } | undefined;
  let said = at?.message ?? String(err);
  while (at?.cause) {
    at = at.cause as { message?: string; cause?: unknown };
    if (at.message) said = at.message;
  }
  return said;
};

export async function closedWith(run: Pick<WorkflowRun, 'result' | 'describe'>): Promise<{ as: ClosedAs; why?: string | undefined }> {
  let why: string | undefined;
  try {
    await run.result();
  } catch (err) {
    if (named(err, 'WorkflowNotFoundError')) return { as: 'NOT_FOUND', why: NOT_IN_TEMPORAL };
    if (!named(err, 'WorkflowFailedError', 'WorkflowContinuedAsNewError')) throw err;
    if (named(err, 'WorkflowFailedError')) why = innermost(err);
  }
  try {
    return { as: (await run.describe()).status.name as ClosedAs, ...(why ? { why } : {}) };
  } catch (err) {
    if (named(err, 'WorkflowNotFoundError')) return { as: 'NOT_FOUND', why: NOT_IN_TEMPORAL };
    throw err;
  }
}

export async function closedAs(run: Pick<WorkflowRun, 'result' | 'describe'>): Promise<ClosedAs> {
  return (await closedWith(run)).as;
}
