import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statusAfterFailure, MAX_LEAF_ATTEMPTS } from './leaves.js';
import { columnFor } from './tree-board.js';

describe('the status an attempt leaves behind', () => {
  it('stays running while there are attempts left', () => {
    expect(statusAfterFailure(1)).toBe('running');
    expect(statusAfterFailure(2)).toBe('running');
  });

  it('fails on the last one', () => {
    expect(statusAfterFailure(MAX_LEAF_ATTEMPTS)).toBe('failed');
  });

  it('fails past the cap, rather than looping back to running', () => {
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
    expect(columnFor(leaf(statusAfterFailure(1)), false)).toBe('running');
  });

  it('still shows a genuinely exhausted leaf as failed', () => {
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
    const at = activity.indexOf('status: nextStatus,');
    expect(activity.slice(at - 200, at)).toMatch(/attempts,/);
  });
});
