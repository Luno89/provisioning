import type { Database } from '../../platform/index.js';
import { projectResolver } from '../../engine/index.js';
import { groveRecordsOf } from '../store.js';

export interface WorkScope {
  projectId?: string | undefined;
  treeId?: string | undefined;
  conversationId?: string | undefined;
}

export type ProjectOfWork = (ownerId: string, scope: WorkScope, refs?: Record<string, unknown>) => Promise<string | undefined>;

export function projectOfWork(db: Pick<Database, 'projects' | 'engine'>): ProjectOfWork {
  const resolver = projectResolver({
    projects: () => db.projects.getProjects(),
    ...groveRecordsOf(db.projects),
    conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
  });
  return async (ownerId, scope, refs = {}) => (await resolver.project(ownerId, refs, scope)).project?.id;
}
