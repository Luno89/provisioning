import { describe, it, expect } from 'vitest';
import { buildLeafContext, MAX_CONTEXT_LEAVES } from './leaf-context.js';
import type { Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Do a thing',
  column: 'todo', status: 'pending', depth: 0, blocking: true,
  createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z',
  ...over,
});

describe('buildLeafContext', () => {
  it('is empty for a branch with no leaves, so a fresh chat carries no dead weight', () => {
    expect(buildLeafContext([])).toBe('');
  });

  it('lists titles with plain-language status', () => {
    const ctx = buildLeafContext([leaf({ title: 'Add rate limiting', status: 'running' })]);
    expect(ctx).toContain('Add rate limiting');
    expect(ctx).toContain('in progress');
  });

  it('uses plain words, never the UI koala vocabulary', () => {
    // "Munching" means nothing to a model and would spend tokens on a joke it cannot get.
    const ctx = buildLeafContext([leaf({ status: 'running' }), leaf({ id: 'l2', status: 'succeeded' })]);
    expect(ctx).not.toMatch(/Munching|Digested|Sprouting|Bitter/);
  });

  it('tells the model not to repeat existing work', () => {
    // The visible symptom without this: the same leaves proposed again every single turn.
    expect(buildLeafContext([leaf()])).toMatch(/Do not propose work that is already listed/);
  });

  it('preserves the shape of the decomposition through indentation', () => {
    const ctx = buildLeafContext([
      leaf({ id: 'root', title: 'Parent', depth: 0 }),
      leaf({ id: 'kid', title: 'Child', depth: 1, createdAt: '2026-08-03T00:00:01Z' }),
    ]);
    const lines = ctx.split('\n');
    expect(lines.find((l) => l.includes('Parent'))!.startsWith('- ')).toBe(true);
    expect(lines.find((l) => l.includes('Child'))!.startsWith('  - ')).toBe(true);
  });

  it('omits bodies, which would dominate the context', () => {
    const ctx = buildLeafContext([leaf({ body: 'A very long description that should not appear.' })]);
    expect(ctx).not.toContain('should not appear');
  });

  it('caps a large branch and says how many were left out', () => {
    const many = Array.from({ length: MAX_CONTEXT_LEAVES + 12 }, (_, i) =>
      leaf({ id: `l${i}`, title: `Leaf ${i}`, createdAt: `2026-08-03T00:00:${String(i).padStart(2, '0')}Z` }));
    const ctx = buildLeafContext(many);
    expect(ctx).toMatch(/…and 12 more/);
    expect(ctx.split('\n').filter((l) => l.trim().startsWith('- ')).length).toBe(MAX_CONTEXT_LEAVES);
  });

  it('handles an unknown status without producing "undefined"', () => {
    const ctx = buildLeafContext([leaf({ status: 'weird' as any })]);
    expect(ctx).not.toContain('undefined');
  });
});
