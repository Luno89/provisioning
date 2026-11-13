import type { ConcludeWorkspaceArgs } from '../engine-host/temporal/contracts.js';
import type { EngineStore } from '../engine/index.js';
import { primaryProjectId, type ProjectsStore } from '../projects/index.js';

export interface WorkspaceProjectActivities {
  WorkspaceProjectActivity(args: ConcludeWorkspaceArgs): Promise<string | null>;
}

export interface WorkspaceProjectStores {
  projects: Pick<ProjectsStore, 'getTrees'>;
  engine: Pick<EngineStore, 'getConversation'>;
}

export function createWorkspaceProjectActivities(stores: WorkspaceProjectStores): WorkspaceProjectActivities {
  return {
    async WorkspaceProjectActivity({ ownerId, workspace }) {
      if (workspace.kind === 'conversation') return (await stores.engine.getConversation(ownerId, workspace.id))?.projectId ?? null;
      const tree = (await stores.projects.getTrees()).find((entry) => entry.id === workspace.id && entry.ownerId === ownerId);
      return (tree ? primaryProjectId(tree) : undefined) ?? null;
    },
  };
}
