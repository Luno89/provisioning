import { describe, it, expect } from 'vitest';
import { MAX_OUTLINE_LEAVES, treeOutline, type OutlineLeaf } from './tree-outline.js';

const tree = { id: 't1', name: 'Greeter', type: 'software', goal: 'A CLI that greets' };
const leaf = (id: string, over: Partial<OutlineLeaf> = {}): OutlineLeaf => ({
  id, branchId: 'b1', title: `Leaf ${id}`, body: `${id} exists`, status: 'pending', ...over,
});

describe('treeOutline', () => {
  it('names the tree, its goal, and every leaf with its id, state, tasks and dependencies', () => {
    const outline = treeOutline(
      tree,
      [{ id: 'b1', treeId: 't1', title: 'Core' }, { id: 'bx', treeId: 'other', title: 'Elsewhere' }],
      [leaf('l1', { status: 'succeeded' }), leaf('l2', { dependsOn: ['l1'] }), leaf('lx', { branchId: 'bx' })],
      [{ leafId: 'l1', status: 'done' }, { leafId: 'l1', status: 'dropped' }, { leafId: 'l2', status: 'accepted' }, { leafId: 'l2', status: 'proposed' }],
    );
    expect(outline).toContain('Tree "Greeter" (t1), type software.');
    expect(outline).toContain('Goal: A CLI that greets');
    expect(outline).toContain('- Core\n  - Leaf l1 (l1) [succeeded, 1/1 tasks done] — l1 exists');
    expect(outline).toContain('  - Leaf l2 (l2) [pending, 0/1 tasks done, waits on l1] — l2 exists');
    expect(outline).not.toContain('Elsewhere');
    expect(outline).not.toContain('lx');
  });

  it('leaves out cancelled leaves', () => {
    const outline = treeOutline(tree, [{ id: 'b1', treeId: 't1', title: 'Core' }], [leaf('kept'), leaf('gone', { status: 'cancelled' })]);
    expect(outline).toContain('[pending, 0/0 tasks done]');
    expect(outline).not.toContain('gone');
  });

  it('says when nothing is planned yet', () => {
    expect(treeOutline({ id: 't1', name: 'Greeter', type: 'software' }, [], [])).toBe('Tree "Greeter" (t1), type software.\nGoal: not written down.\n\nNothing is planned in it yet.');
  });

  it('caps a large tree and says how many it left out', () => {
    const many = Array.from({ length: MAX_OUTLINE_LEAVES + 5 }, (_, i) => leaf(`l${i}`));
    const outline = treeOutline(tree, [{ id: 'b1', treeId: 't1', title: 'Core' }], many);
    expect(outline).toContain('…and 5 more');
    expect(outline).not.toContain(`(l${MAX_OUTLINE_LEAVES})`);
  });
});
