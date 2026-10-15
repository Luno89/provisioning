import { describe, it, expect } from 'vitest';
import { projectApps, projectRemovalPreview, projectRemovalScope, projectWorkflowIds, type ProjectWorld } from './project-removal.js';

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
    expect(projectWorkflowIds(scope)).toEqual(['odoo-release-p1', 'release-p1', 'pipeline-r1', 'grove-run-t1', 'conclude-workspace-tree-t1']);
  });

  it('says what it will do, for the person to read before agreeing', () => {
    expect(projectRemovalPreview(project, projectRemovalScope(project, world()))).toEqual({
      name: 'shop', repository: 'koala-bo/shop', trees: [{ id: 't1', name: 'Shop features', leaves: 1, conversations: 1 }], keptConversations: 1, builds: 2, apps: [],
    });
  });

  it('takes the apps built from it, by their project or, for an older one, by its name, and only the owner\'s', () => {
    const deployments = [
      { id: 'd1', name: 'shop', clusterId: 'c', strategy: 'helm', appType: 'odoo-project', ownerId: 'bo', gitappProjectId: 'p1' },
      { id: 'd2', name: 'shop', clusterId: 'c', strategy: 'helm', appType: 'gitapp', ownerId: 'bo' },
      { id: 'd3', name: 'shop', clusterId: 'c', strategy: 'helm', appType: 'gitapp', ownerId: 'bo', gitappProjectId: 'p9' },
      { id: 'd4', name: 'wordpress', clusterId: 'c', strategy: 'helm', appType: 'wordpress', ownerId: 'bo' },
      { id: 'd5', name: 'shop', clusterId: 'c', strategy: 'helm', appType: 'odoo-project', ownerId: 'cy', gitappProjectId: 'p1' },
    ] as never[];
    expect(projectApps(project, deployments).map((app: { id: string }) => app.id)).toEqual(['d1', 'd2', 'd5']);
    const scope = projectRemovalScope(project, world({ deployments }));
    expect(scope.apps).toEqual([{ id: 'd1', name: 'shop' }, { id: 'd2', name: 'shop' }]);
    expect(projectRemovalPreview(project, scope).apps).toEqual(['shop', 'shop']);
  });
});

describe('the channel of a project being deleted', () => {
  it('goes with it, while other chats about it are kept and unlinked', () => {
    const scope = projectRemovalScope(project, world({ trees: [], conversations: [{ id: 'channel-p1', ownerId: 'bo', projectId: 'p1', kind: 'channel' }, { id: 'side', ownerId: 'bo', projectId: 'p1' }] }));
    expect(scope.channelIds).toEqual(['channel-p1']);
    expect(scope.keptConversationIds).toEqual(['side']);
  });
});
