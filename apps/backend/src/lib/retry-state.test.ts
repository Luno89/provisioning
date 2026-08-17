import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statusAfterFailure, MAX_LEAF_ATTEMPTS } from './leaves.js';
import { columnFor } from './tree-board.js';

/**
 * A leaf that is about to be retried is not failed.
 *
 * ── WHAT THE BOARD SHOWED ──
 * Every attempt wrote `status: 'failed'`, including ones with retries left. Observed on a real run:
 * a leaf failed twice, succeeded on the third, ended `verified: true` and `merged: true` — and
 * showed a red failed icon for most of the time it was working.
 *
 * The UI was faithful; the record was not. The branch notice had the distinction all along —
 * "failed (attempt 1 of 3) and will retry" versus "failed and will not be retried" — so the
 * conversation told the truth while the one field the icon reads did not.
 */

describe('the status an attempt leaves behind', () => {
  it('stays running while there are attempts left', () => {
    expect(statusAfterFailure(1)).toBe('running');
    expect(statusAfterFailure(2)).toBe('running');
  });

  it('fails on the last one', () => {
    // Temporal counts from 1, so attempt 3 of 3 is the end of the road.
    expect(statusAfterFailure(MAX_LEAF_ATTEMPTS)).toBe('failed');
  });

  it('fails past the cap, rather than looping back to running', () => {
    // Defensive: a policy change or a replayed history must never produce an immortal leaf.
    expect(statusAfterFailure(MAX_LEAF_ATTEMPTS + 1)).toBe('failed');
    expect(statusAfterFailure(99)).toBe('failed');
  });

  it('honours a caller-supplied cap', () => {
    expect(statusAfterFailure(1, 1)).toBe('failed');
    expect(statusAfterFailure(4, 5)).toBe('running');
  });
});

describe('what a person sees for each', () => {
  const leaf = (status: string) => ({ id: 'l1', status, dependsOn: [] } as any);

  it('shows a retrying leaf as running, not failed', () => {
    // The whole point: no red icon for work that is still going.
    expect(columnFor(leaf(statusAfterFailure(1)), false)).toBe('running');
  });

  it('still shows a genuinely exhausted leaf as failed', () => {
    // The opposite failure would be worse — hiding a leaf that has given up.
    expect(columnFor(leaf(statusAfterFailure(MAX_LEAF_ATTEMPTS)), false)).toBe('failed');
  });
});

describe('where it is applied', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const activity = readFileSync(join(here, '../activities/ExecuteLeafActivity.ts'), 'utf8');

  it('writes the derived status, not a literal failed', () => {
    expect(activity).toMatch(/const nextStatus = statusAfterFailure\(attemptNumber, MAX_LEAF_ATTEMPTS\)/);
    expect(activity).toMatch(/status: nextStatus,/);
  });

  it('still records the attempt either way, so nothing is hidden', () => {
    /**
     * The failures are what LeafDetail lists, and the count is what makes a struggling leaf
     * visible while it struggles. Softening the status must not soften the evidence.
     */
    const at = activity.indexOf('status: nextStatus,');
    expect(activity.slice(at - 200, at)).toMatch(/attempts,/);
  });
});
