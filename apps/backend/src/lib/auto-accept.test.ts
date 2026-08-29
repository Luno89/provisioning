import { describe, it, expect } from 'vitest';
import { review, reviewBatch, DEFAULT_POLICY, MAX_AUTO_ACCEPT } from './auto-accept.js';
import type { Leaf } from './leaves.js';
import { acceptLeaf } from './accept-leaf.js';

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
  personaId: 'p-builder',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
} as Leaf);

const ON = { ...DEFAULT_POLICY, enabled: true };

const unassigned = (): Leaf => { const { personaId, ...rest } = leaf(); return rest as Leaf; };

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

describe('accepting by hand', () => {
  it('refuses a leaf with no persona, the same as the automatic path', async () => {
    const { personaId, ...unassignedLeaf } = leaf();
    const result = await acceptLeaf({ db: { saveLeaf: async () => {}, getBranches: withPlan } }, unassignedLeaf as Leaf, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no persona/i);
  });

  it('accepts an assigned one', async () => {
    const saved: Leaf[] = [];
    const result = await acceptLeaf(
      { db: { saveLeaf: async (l: Leaf) => { saved.push(l); }, getBranches: withPlan } }, leaf(), []);
    expect(result.ok).toBe(true);
    expect(saved[0]!.status).toBe('pending');
  });

  it('refuses when nothing would check the finished result', async () => {
    const result = await acceptLeaf(
      { db: { saveLeaf: async () => {}, getBranches: async () => [{ id: 'b1' } as any] } }, leaf(), []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/set_acceptance/);
    }
  });

  it('refuses when the branch declares a plan of no usable checks', async () => {
    const empty = async () => [{ id: 'b1', acceptance: [{ name: 'blank', command: '  ' }] } as any];
    const result = await acceptLeaf({ db: { saveLeaf: async () => {}, getBranches: empty } }, leaf(), []);
    expect(result.ok).toBe(false);
  });

  it('refuses when the leaf\'s branch cannot be found at all', async () => {
    const result = await acceptLeaf(
      { db: { saveLeaf: async () => {}, getBranches: async () => [] }, }, leaf(), []);
    expect(result.ok).toBe(false);
  });

  it('checks the plan on the leaf\'s OWN branch', async () => {
    const other = async () => [{ id: 'somewhere-else', acceptance: [{ name: 'c', command: 'true' }] } as any];
    const result = await acceptLeaf({ db: { saveLeaf: async () => {}, getBranches: other } }, leaf(), []);
    expect(result.ok).toBe(false);
  });
});
