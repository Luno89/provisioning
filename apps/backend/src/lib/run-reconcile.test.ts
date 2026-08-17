import { describe, it, expect } from 'vitest';
import { reconcileRun, reconcileMissingWorkflow, statusFromWorkflow } from './run-reconcile.js';

/**
 * A pipeline run saying what actually happened to it.
 *
 * ── THE OBSERVED FAILURE ──
 * Five runs sat at `queued` for over three hours after their workflows had been terminated. The
 * queue read as permanently busy and nothing disagreed, because the only thing that would have
 * written `failed` was the tracker that had already stopped watching.
 *
 * ── AND THE FAILURE THE FIX COULD CAUSE ──
 * Most of what follows guards the other direction. A reconciliation that guesses turns a brief
 * Temporal outage into every run being marked failed, which is worse than the stale record it
 * replaced — a wrong answer given confidently beats a missing one only for the person who wrote it.
 */

describe('what a workflow state means for a run', () => {
  it('maps the terminal states', () => {
    expect(statusFromWorkflow('COMPLETED')).toBe('succeeded');
    for (const s of ['FAILED', 'TERMINATED', 'TIMED_OUT', 'CANCELED']) {
      // All "not coming back" from the run's point of view, which is what a person needs to know.
      expect(statusFromWorkflow(s)).toBe('failed');
    }
  });

  it('keeps a continued-as-new workflow running', () => {
    // A long crawl continues as new constantly; reading that as an ending would mark live work done.
    expect(statusFromWorkflow('CONTINUED_AS_NEW')).toBe('running');
  });

  it('says nothing for a state it does not recognise', () => {
    /**
     * The load-bearing default. Temporal being unreachable and Temporal reporting something new
     * arrive here identically, and guessing at either would mark healthy runs failed.
     */
    expect(statusFromWorkflow(undefined)).toBeUndefined();
    expect(statusFromWorkflow('SOMETHING_NEW')).toBeUndefined();
  });
});

describe('when a record should be rewritten', () => {
  it('rewrites a queued run whose workflow was terminated', () => {
    // The exact case: five of these, stale for three hours.
    expect(reconcileRun('queued', 'TERMINATED')).toBe('failed');
  });

  it('promotes a queued run whose workflow actually finished', () => {
    expect(reconcileRun('queued', 'COMPLETED')).toBe('succeeded');
  });

  it('leaves a run alone while its workflow is genuinely running', () => {
    expect(reconcileRun('running', 'RUNNING')).toBeUndefined();
  });

  it('NEVER un-settles a finished run', () => {
    /**
     * The dangerous direction. Temporal expires workflow history, so a succeeded run from last week
     * looks like a workflow that does not exist — and re-deriving it would flip completed work to
     * failed for no reason other than the passage of time.
     */
    expect(reconcileRun('succeeded', 'TERMINATED')).toBeUndefined();
    expect(reconcileRun('succeeded', undefined)).toBeUndefined();
    expect(reconcileRun('failed', 'COMPLETED')).toBeUndefined();
  });

  it('says nothing when Temporal could not answer', () => {
    // A brief outage must not become a wave of false failures.
    expect(reconcileRun('queued', undefined)).toBeUndefined();
  });
});

describe('a workflow Temporal has never heard of', () => {
  const now = new Date('2026-08-17T18:00:00Z').getTime();
  const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();

  it('fails an old run whose workflow is gone', () => {
    // NOT_FOUND is an answer: terminated and aged out, or never started. Either way it is not
    // coming back, and leaving it queued is the bug.
    expect(reconcileMissingWorkflow('queued', ago(30), now)).toBe('failed');
  });

  it('gives a brand-new run time to appear', () => {
    /**
     * A run started a second ago may legitimately not be visible yet, and marking it failed would
     * be a race the reconciler wins about once a day.
     */
    expect(reconcileMissingWorkflow('queued', ago(0), now)).toBeUndefined();
    expect(reconcileMissingWorkflow('queued', new Date(now - 5_000).toISOString(), now)).toBeUndefined();
  });

  it('leaves a settled run alone however old it is', () => {
    expect(reconcileMissingWorkflow('succeeded', ago(10_000), now)).toBeUndefined();
  });

  it('does nothing when the record has no start time', () => {
    // Without one there is no way to tell "just started" from "long gone", and the safe answer is
    // to leave it.
    expect(reconcileMissingWorkflow('queued', undefined, now)).toBeUndefined();
    expect(reconcileMissingWorkflow('queued', 'not a date', now)).toBeUndefined();
  });
});
