import { describe, it, expect } from 'vitest';
import { projectRemovalBlockers, projectRemovalPreview, projectRemovalScope, projectWorkflowIds, type ProjectWorld } from './project-removal.js';

const project = { id: 'p1', name: 'shop', ownerId: 'bo', giteaOwner: 'koala-bo', giteaRepo: 'shop' };

const world = (over: Partial<ProjectWorld> = {}): ProjectWorld => ({
  trees: [
    { id: 't1', name: 'Shop features', ownerId: 'bo', projectIds: ['p1'] },
    { id: 't2', name: 'Shared tooling', ownerId: 'bo', projectIds: ['p0', 'p1'] },
    { id: 't3', name: 'Someone else\'s', ownerId: 'cy', projectIds: ['p1'] },
  ],
  branches: [{ id: 'b1', treeId: 't1' }],
  leaves: [{ id: 'l1', branchId: 'b1' }],
  tasks: [{ id: 'k1', leafId: 'l1' }],
  proposals: [],
  conversations: [{ id: 'c1', ownerId: 'bo', treeId: 't1', projectId: 'p1' }, { id: 'c2', ownerId: 'bo', projectId: 'p1' }],
  deployments: [],
  pipelineRuns: [{ id: 'r1', projectId: 'p1', status: 'running', temporalWorkflowId: 'pipeline-r1' }, { id: 'r2', projectId: 'p1', status: 'succeeded', temporalWorkflowId: 'pipeline-r2' }],
  ...over,
});

describe('what deleting a project takes with it', () => {
  it('takes the trees it is the home of, with their leaves and conversations; unlinks a tree whose home is elsewhere; keeps a conversation that only mentions it', () => {
    const scope = projectRemovalScope(project, world());

    expect(scope.trees.map((tree) => [tree.id, tree.scope.leafIds, tree.scope.conversationIds])).toEqual([['t1', ['l1'], ['c1']]]);
    expect(scope.unlinkedTreeIds).toEqual(['t2']);
    expect(scope.keptConversationIds).toEqual(['c2']);
    expect(scope.repository).toBe('koala-bo/shop');
    expect(projectWorkflowIds(scope)).toEqual(['odoo-release-p1', 'pipeline-r1', 'grove-run-t1', 'conclude-workspace-tree-t1']);
  });

  it('says what it will do, for the person to read before agreeing', () => {
    expect(projectRemovalPreview(project, projectRemovalScope(project, world()), [])).toEqual({
      name: 'shop', repository: 'koala-bo/shop', trees: [{ id: 't1', name: 'Shop features', leaves: 1, conversations: 1 }], keptConversations: 1, builds: 2, blockers: [],
    });
  });

  it('is refused while an app built from it is deployed', () => {
    expect(projectRemovalBlockers(project, { deployments: [{ id: 'd1', name: 'shop-web', clusterId: 'c', strategy: 'helm', gitappProjectId: 'p1' } as never] }))
      .toEqual(['the app "shop-web" built from it is still deployed; remove it first']);
    expect(projectRemovalBlockers(project, { deployments: [] })).toEqual([]);
  });
});
