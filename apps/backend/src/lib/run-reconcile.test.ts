import { describe, it, expect } from 'vitest';
import { reconcileRun, reconcileMissingWorkflow, statusFromWorkflow } from './run-reconcile.js';

describe('what a workflow state means for a run', () => {
  it('maps the terminal states', () => {
    expect(statusFromWorkflow('COMPLETED')).toBe('succeeded');
    for (const s of ['FAILED', 'TERMINATED', 'TIMED_OUT', 'CANCELED']) {
      expect(statusFromWorkflow(s)).toBe('failed');
    }
  });

  it('keeps a continued-as-new workflow running', () => {
    expect(statusFromWorkflow('CONTINUED_AS_NEW')).toBe('running');
  });

  it('says nothing for a state it does not recognise', () => {
    expect(statusFromWorkflow(undefined)).toBeUndefined();
    expect(statusFromWorkflow('SOMETHING_NEW')).toBeUndefined();
  });
});

describe('when a record should be rewritten', () => {
  it('rewrites a queued run whose workflow was terminated', () => {
    expect(reconcileRun('queued', 'TERMINATED')).toBe('failed');
  });

  it('promotes a queued run whose workflow actually finished', () => {
    expect(reconcileRun('queued', 'COMPLETED')).toBe('succeeded');
  });

  it('leaves a run alone while its workflow is genuinely running', () => {
    expect(reconcileRun('running', 'RUNNING')).toBeUndefined();
  });

  it('NEVER un-settles a finished run', () => {
    expect(reconcileRun('succeeded', 'TERMINATED')).toBeUndefined();
    expect(reconcileRun('succeeded', undefined)).toBeUndefined();
    expect(reconcileRun('failed', 'COMPLETED')).toBeUndefined();
  });

  it('says nothing when Temporal could not answer', () => {
    expect(reconcileRun('queued', undefined)).toBeUndefined();
  });
});

describe('a workflow Temporal has never heard of', () => {
  const now = new Date('2026-08-17T18:00:00Z').getTime();
  const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();

  it('fails an old run whose workflow is gone', () => {
    expect(reconcileMissingWorkflow('queued', ago(30), now)).toBe('failed');
  });

  it('gives a brand-new run time to appear', () => {
    expect(reconcileMissingWorkflow('queued', ago(0), now)).toBeUndefined();
    expect(reconcileMissingWorkflow('queued', new Date(now - 5_000).toISOString(), now)).toBeUndefined();
  });

  it('leaves a settled run alone however old it is', () => {
    expect(reconcileMissingWorkflow('succeeded', ago(10_000), now)).toBeUndefined();
  });

  it('does nothing when the record has no start time', () => {
    expect(reconcileMissingWorkflow('queued', undefined, now)).toBeUndefined();
    expect(reconcileMissingWorkflow('queued', 'not a date', now)).toBeUndefined();
  });
});
