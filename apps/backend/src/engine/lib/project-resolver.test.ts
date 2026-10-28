import { describe, expect, it } from 'vitest';
import { projectResolver } from './project-resolver.js';

const resolver = projectResolver({
  projects: async () => [{ id: 'p1', ownerId: 'o', name: 'Shop', giteaRepo: 'shop-repo' }, { id: 'p2', ownerId: 'o', name: 'Secret Plans' }, { id: 'p3', ownerId: 'someone-else', name: 'Theirs' }],
  trees: async () => [{ id: 't1', ownerId: 'o', projectIds: ['p1'] }, { id: 't2', ownerId: 'o', projectIds: ['p2'] }],
  branches: async () => [{ id: 'b1', ownerId: 'o', treeId: 't1' }, { id: 'b2', ownerId: 'o', treeId: 't2' }],
  leaves: async () => [{ id: 'l1', ownerId: 'o', branchId: 'b1' }, { id: 'l2', ownerId: 'o', branchId: 'b2' }],
  tasks: async () => [{ id: 'k1', leafId: 'l1' }, { id: 'k2', leafId: 'l2' }, { id: 'k3', projectId: 'p1' }],
  conversation: async (_owner, id) => (id === 'c1' ? { projectId: 'p1' } : id === 'c2' ? { treeId: 't2' } : undefined),
});

describe('which project a call reaches', () => {
  it('follows an argument naming the project, a tree, a feature, a story, stories or a task to its project', async () => {
    expect(await resolver.project('o', { project: 'shop' }, {})).toEqual({ project: { id: 'p1', ownerId: 'o' } });
    expect(await resolver.project('o', { project: 'SHOP-REPO' }, {})).toEqual({ project: { id: 'p1', ownerId: 'o' } });
    expect(await resolver.project('o', { projectId: 'p2' }, {})).toEqual({ project: { id: 'p2', ownerId: 'o' } });
    expect(await resolver.project('o', { treeId: 't1' }, {})).toEqual({ project: { id: 'p1', ownerId: 'o' } });
    expect(await resolver.project('o', { branchId: 'b2' }, {})).toEqual({ project: { id: 'p2', ownerId: 'o' } });
    expect(await resolver.project('o', { leafId: 'l1' }, {})).toEqual({ project: { id: 'p1', ownerId: 'o' } });
    expect(await resolver.project('o', { leafIds: ['l1'] }, {})).toEqual({ project: { id: 'p1', ownerId: 'o' } });
    expect(await resolver.project('o', { taskId: 'k3' }, {})).toEqual({ project: { id: 'p1', ownerId: 'o' } });
    expect(await resolver.project('o', { taskId: 'k2' }, {})).toEqual({ project: { id: 'p2', ownerId: 'o' } });
  });

  it('says which argument named something that is not the owner\'s, and stories of two projects at once', async () => {
    expect(await resolver.project('o', { projectId: 'p3' }, {})).toEqual({ outside: 'projectId' });
    expect(await resolver.project('o', { projectId: 'nope' }, {})).toEqual({ outside: 'projectId' });
    expect(await resolver.project('o', { project: 'Theirs' }, {})).toEqual({ outside: 'project' });
    expect(await resolver.project('o', { treeId: 't9' }, {})).toEqual({ outside: 'treeId' });
    expect(await resolver.project('o', { leafIds: ['l1', 'l2'] }, {})).toEqual({ outside: 'leafIds' });
  });

  it('falls back to the run\'s project, its tree, then its conversation, and otherwise names none', async () => {
    expect(await resolver.project('o', {}, { projectId: 'p1' })).toEqual({ project: { id: 'p1', ownerId: 'o' } });
    expect(await resolver.project('o', {}, { treeId: 't2' })).toEqual({ project: { id: 'p2', ownerId: 'o' } });
    expect(await resolver.project('o', {}, { conversationId: 'c1' })).toEqual({ project: { id: 'p1', ownerId: 'o' } });
    expect(await resolver.project('o', {}, { conversationId: 'c2' })).toEqual({ project: { id: 'p2', ownerId: 'o' } });
    expect(await resolver.project('o', {}, { conversationId: 'c9' })).toEqual({});
    expect(await resolver.project('o', {}, {})).toEqual({});
  });
});
