import { describe, it, expect } from 'vitest';
import { review, reviewBatch, DEFAULT_POLICY, MAX_AUTO_ACCEPT } from './auto-accept.js';
import type { Leaf } from './leaves.js';

const withPlan = async () => [
  { id: 'b1', acceptance: [{ name: 'runs', command: 'node src/cli.js' }] } as any,
];

const leaf = (over: Record<string, unknown> = {}): Leaf => ({
  id: 'l1',
  ownerId: 'u1',
  branchId: 'b1',
  title: 'Implement MCP Tools for GitHub REST API',
  body: 'Expose gh_list_repos, gh_get_issue and gh_create_issue as MCP tools with JSON schemas.',
  status: 'proposed',
  column: 'todo',
  packId: 'p-builder',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
} as Leaf);

const ON = { ...DEFAULT_POLICY, enabled: true };

const unassigned = (): Leaf => { const { packId, ...rest } = leaf(); return rest as Leaf; };

describe('whether one proposal is routine', () => {
  it('accepts a well-formed, assigned leaf', () => {
    expect(review(leaf(), [], ON)).toMatchObject({ accept: true });
  });

  it('holds a leaf with no persona', () => {
    const v = review(unassigned(), [], ON);
    expect(v.accept).toBe(false);
    expect(v.reason).toMatch(/persona/i);
  });

  it('holds a placeholder title or an empty body', () => {
    expect(review(leaf({ title: 'TODO' }), [], ON).accept).toBe(false);
    expect(review(leaf({ body: 'do it' }), [], ON).accept).toBe(false);
  });

  it('holds work that has already been accepted', () => {
    const done = leaf({ id: 'l0', status: 'succeeded' });
    const v = review(leaf(), [done], ON);
    expect(v.accept).toBe(false);
    expect(v.reason).toMatch(/already been accepted/i);
  });

  it('does not treat another untouched proposal as a duplicate', () => {
    const other = leaf({ id: 'l0', status: 'proposed' });
    expect(review(leaf(), [other], ON).accept).toBe(true);
  });

  it('ignores anything that is not a proposal', () => {
    expect(review(leaf({ status: 'pending' }), [], ON).accept).toBe(false);
  });
});

describe('reviewing a batch', () => {
  it('does nothing at all when the policy is off', () => {
    const out = reviewBatch([leaf()], [], DEFAULT_POLICY);
    expect(out[0]!.verdict).toMatchObject({ accept: false, reason: 'auto-accept is off' });
  });

  it('holds the whole batch when there are too many', () => {
    const many = Array.from({ length: MAX_AUTO_ACCEPT + 1 }, (_, i) => leaf({ id: `l${i}` }));
    const out = reviewBatch(many, [], ON);
    expect(out.every((r) => !r.verdict.accept)).toBe(true);
    expect(out[0]!.verdict.reason).toMatch(/more than the 8/);
  });

  it('catches a duplicate that appears twice within one batch', () => {
    const out = reviewBatch([leaf({ id: 'a' }), leaf({ id: 'b' })], [], ON);
    expect(out[0]!.verdict.accept).toBe(true);
    expect(out[1]!.verdict.accept).toBe(false);
  });

  it('accepts the good ones and says why it held the rest', () => {
    const out = reviewBatch(
      [leaf({ id: 'a' }), { ...unassigned(), id: 'b', title: 'Rate limits' }],
      [],
      ON,
    );
    expect(out.filter((r) => r.verdict.accept)).toHaveLength(1);
    expect(out.every((r) => r.verdict.reason.length > 0)).toBe(true);
  });
});

