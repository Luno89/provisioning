import { describe, it, expect } from 'vitest';
import { deletionScope, type GroveWorld } from './grove-deletion.js';

const world: GroveWorld = {
  branches: [{ id: 'b1', treeId: 't1' }, { id: 'b2', treeId: 't1' }, { id: 'bx', treeId: 'other' }],
  leaves: [
    { id: 'l1', branchId: 'b1' },
    { id: 'l1-child', branchId: 'b1', parentLeafId: 'l1' },
    { id: 'l1-grandchild', branchId: 'b1', parentLeafId: 'l1-child' },
    { id: 'l2', branchId: 'b2' },
    { id: 'lx', branchId: 'bx' },
  ],
  tasks: [{ id: 'k1', leafId: 'l1' }, { id: 'k2', leafId: 'l1-grandchild' }, { id: 'k3', leafId: 'l2' }, { id: 'kx', leafId: 'lx' }, { id: 'loose' }],
  proposals: [
    { id: 'grow', status: 'proposed', plan: { treeId: 't1', planDoc: '', branches: [] } },
    { id: 'origin', status: 'adopted', plan: { tree: { name: 'T', type: 'x' }, planDoc: '', branches: [] }, adopted: { treeId: 't1', branchIds: ['b1'], leafIds: {}, taskIds: {} } },
    { id: 'replan-l1', status: 'adopting', leafPlan: { treeId: 't1', leafId: 'l1', leafTitle: 'l1', mode: 'replan', why: 'w', brief: 'b', tasks: [] } },
    { id: 'replan-l2', status: 'proposed', leafPlan: { treeId: 't1', leafId: 'l2', leafTitle: 'l2', mode: 'replan', why: 'w', brief: 'b', tasks: [] } },
    { id: 'chatted', status: 'rejected', conversationId: 'c1', plan: { tree: { name: 'N', type: 'x' }, planDoc: '', branches: [] } },
    { id: 'elsewhere', status: 'proposed', plan: { treeId: 'other', planDoc: '', branches: [] } },
  ],
  conversations: [{ id: 'c1', treeId: 't1' }, { id: 'c2', treeId: 'other' }, { id: 'c3' }],
};

describe('deletionScope', () => {
  it('takes everything about a tree: branches, every leaf and sub-leaf, their tasks, its proposals and its conversations', () => {
    const scope = deletionScope({ kind: 'tree', id: 't1' }, world);
    expect(scope.treeId).toBe('t1');
    expect(scope.branchIds).toEqual(['b1', 'b2']);
    expect(scope.leafIds.sort()).toEqual(['l1', 'l1-child', 'l1-grandchild', 'l2']);
    expect(scope.taskIds.sort()).toEqual(['k1', 'k2', 'k3']);
    expect(scope.proposalIds.sort()).toEqual(['chatted', 'grow', 'origin', 'replan-l1', 'replan-l2']);
    expect(scope.adoptingProposalIds).toEqual(['replan-l1']);
    expect(scope.conversationIds).toEqual(['c1']);
  });

  it('takes a branch with its leaves, their tasks and the leaf plans for them, but not the tree\'s own history', () => {
    const scope = deletionScope({ kind: 'branch', id: 'b1' }, world);
    expect(scope.treeId).toBeUndefined();
    expect(scope.branchIds).toEqual(['b1']);
    expect(scope.leafIds.sort()).toEqual(['l1', 'l1-child', 'l1-grandchild']);
    expect(scope.taskIds.sort()).toEqual(['k1', 'k2']);
    expect(scope.proposalIds).toEqual(['replan-l1']);
    expect(scope.conversationIds).toEqual([]);
  });

  it('takes a leaf with its sub-leaves, their tasks and its leaf plans', () => {
    const scope = deletionScope({ kind: 'leaf', id: 'l1-child' }, world);
    expect(scope.branchIds).toEqual([]);
    expect(scope.leafIds.sort()).toEqual(['l1-child', 'l1-grandchild']);
    expect(scope.taskIds).toEqual(['k2']);
    expect(scope.proposalIds).toEqual([]);
  });
});
