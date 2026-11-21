import type { Database } from '../../platform/lib/db-interface.js';

export async function seedTwoProjects(db: Pick<Database, 'projects' | 'engine' | 'releases'>, at: string): Promise<void> {
  for (const id of ['p1', 'p2']) {
    await db.projects.saveProject({ id, name: `shop-${id}`, ownerId: 'bo', giteaOwner: 'koala-bo', giteaRepo: `shop-${id}`, appType: 'gitapp', createdAt: at });
  }
  await db.projects.saveGiteaAccount({ ownerId: 'bo', username: 'koala-bo', passwordEnc: 'x', createdAt: at });
  await db.projects.saveTree({ id: 't1', ownerId: 'bo', name: 'Shop features', type: 'software', projectIds: ['p1'], createdAt: at, updatedAt: at } as never);
  await db.projects.saveTree({ id: 't2', ownerId: 'bo', name: 'Shared', type: 'software', projectIds: ['p2', 'p1'], createdAt: at, updatedAt: at } as never);
  await db.projects.saveBranch({ id: 'b1', ownerId: 'bo', treeId: 't1', title: 'b', createdAt: at, updatedAt: at } as never);
  await db.projects.saveLeaf({ id: 'l1', ownerId: 'bo', branchId: 'b1', title: 'l', status: 'pending', createdAt: at, updatedAt: at } as never);
  await db.projects.saveTask({ id: 'k1', ownerId: 'bo', leafId: 'l1', title: 'k', doneMeans: 'x', dependsOn: [], status: 'accepted', runs: [], createdAt: at, updatedAt: at });
  await db.projects.saveTask({ id: 'k2', ownerId: 'bo', projectId: 'p1', title: 'plain', doneMeans: 'x', dependsOn: [], status: 'accepted', runs: [], createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'c1', ownerId: 'bo', treeId: 't1', projectId: 'p1', messages: [], createdAt: at, updatedAt: at } as never);
  await db.engine.saveConversation({ id: 'c2', ownerId: 'bo', projectId: 'p1', messages: [], createdAt: at, updatedAt: at } as never);
  await db.releases.savePipelineRun({ id: 'r1', projectId: 'p1', status: 'running', temporalWorkflowId: 'pipeline-r1', startedAt: at } as never);
  await db.releases.savePipelineRun({ id: 'r2', projectId: 'p2', status: 'running', temporalWorkflowId: 'pipeline-r2', startedAt: at } as never);
}
