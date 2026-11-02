import type { WorkflowRun } from './workflows.js';

export type ClosedAs = 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TERMINATED' | 'TIMED_OUT' | 'CONTINUED_AS_NEW' | 'NOT_FOUND' | 'RUNNING';

const named = (err: unknown, ...names: string[]): boolean => names.includes((err as { name?: string } | undefined)?.name ?? '');

export async function closedAs(run: Pick<WorkflowRun, 'result' | 'describe'>): Promise<ClosedAs> {
  try {
    await run.result();
  } catch (err) {
    if (named(err, 'WorkflowNotFoundError')) return 'NOT_FOUND';
    if (!named(err, 'WorkflowFailedError', 'WorkflowContinuedAsNewError')) throw err;
  }
  try {
    return (await run.describe()).status.name as ClosedAs;
  } catch (err) {
    if (named(err, 'WorkflowNotFoundError')) return 'NOT_FOUND';
    throw err;
  }
}
