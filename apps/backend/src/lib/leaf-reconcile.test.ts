import { describe, it, expect } from 'vitest';
import { LIVE_LEAF_STATUSES, reconcileLeaf, reconcileMissingLeafWorkflow } from './leaf-reconcile.js';

describe('LIVE_LEAF_STATUSES', () => {
  it('covers exactly the states that are owed an answer', () => {
    expect([...LIVE_LEAF_STATUSES].sort()).toEqual(['pending', 'running']);
  });
});

describe('reconcileLeaf — the workflow is known', () => {
  it('leaves a genuinely running leaf alone', () => {
    expect(reconcileLeaf('running', 'RUNNING', 0)).toBeUndefined();
    expect(reconcileLeaf('pending', 'RUNNING', 0)).toBeUndefined();
  });

  it('says nothing when Temporal could not be read', () => {
    expect(reconcileLeaf('running', undefined, 0)).toBeUndefined();
  });

  it('never touches a leaf that has already settled', () => {
    expect(reconcileLeaf('succeeded', 'TERMINATED', 0)).toBeUndefined();
    expect(reconcileLeaf('failed', 'COMPLETED', 0)).toBeUndefined();
    expect(reconcileLeaf('cancelled', 'TERMINATED', 0)).toBeUndefined();
    expect(reconcileLeaf('proposed', 'TERMINATED', 0)).toBeUndefined();
  });

  it('fails a leaf whose workflow ended without recording an outcome', () => {
    const out = reconcileLeaf('running', 'COMPLETED', 0);
    expect(out?.action).toBe('fail');
    expect(out?.reason).toMatch(/without recording an outcome/i);
  });

  it('does not restart a leaf a human terminated', () => {
    expect(reconcileLeaf('running', 'TERMINATED', 0)?.action).toBe('fail');
    expect(reconcileLeaf('running', 'CANCELED', 0)?.action).toBe('fail');
  });

  it('fails a leaf whose workflow failed or timed out', () => {
    expect(reconcileLeaf('running', 'FAILED', 0)?.action).toBe('fail');
    expect(reconcileLeaf('running', 'TIMED_OUT', 0)?.action).toBe('fail');
  });
});

describe('reconcileMissingLeafWorkflow — the workflow is gone', () => {
  const HOUR = 3_600_000;
  const old = new Date(Date.now() - 48 * HOUR).toISOString();
  const now = Date.now();

  it('restarts an orphan that never got to try', () => {
    const out = reconcileMissingLeafWorkflow('pending', old, 0, now);
    expect(out?.action).toBe('restart');
  });

  it('restarts a running orphan while retries remain', () => {
    expect(reconcileMissingLeafWorkflow('running', old, 1, now)?.action).toBe('restart');
  });

  it('fails an orphan that has already used its attempts', () => {
    const out = reconcileMissingLeafWorkflow('running', old, 3, now);
    expect(out?.action).toBe('fail');
    expect(out?.reason).toMatch(/attempts/i);
  });

  it('waits out a grace period, so a leaf started a moment ago is not stolen', () => {
    const justNow = new Date(now - 5_000).toISOString();
    expect(reconcileMissingLeafWorkflow('pending', justNow, 0, now)).toBeUndefined();
  });

  it('ignores a leaf that has already settled', () => {
    expect(reconcileMissingLeafWorkflow('succeeded', old, 0, now)).toBeUndefined();
    expect(reconcileMissingLeafWorkflow('cancelled', old, 0, now)).toBeUndefined();
  });

  it('does nothing without a usable timestamp rather than acting on a guess', () => {
    expect(reconcileMissingLeafWorkflow('pending', undefined, 0, now)).toBeUndefined();
    expect(reconcileMissingLeafWorkflow('pending', 'not-a-date', 0, now)).toBeUndefined();
  });
});
