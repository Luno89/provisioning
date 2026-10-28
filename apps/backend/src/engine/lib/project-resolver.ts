import type { ProjectResolution } from './tool-access.js';

export interface ProjectWorld {
  projects: () => Promise<readonly { id: string; ownerId?: string | undefined; name: string; giteaRepo?: string | undefined }[]>;
  trees: () => Promise<readonly { id: string; ownerId?: string | undefined; projectIds?: string[] | undefined }[]>;
  branches: () => Promise<readonly { id: string; ownerId?: string | undefined; treeId: string }[]>;
  leaves: () => Promise<readonly { id: string; ownerId?: string | undefined; branchId: string }[]>;
  tasks: (ownerId: string) => Promise<readonly { id: string; leafId?: string | undefined; projectId?: string | undefined }[]>;
  conversation?: ((ownerId: string, id: string) => Promise<{ projectId?: string | undefined; treeId?: string | undefined } | undefined>) | undefined;
}

export interface ProjectResolver {
  project(ownerId: string, refs: Readonly<Record<string, unknown>>, scope: { projectId?: string | undefined; treeId?: string | undefined; conversationId?: string | undefined }): Promise<ProjectResolution>;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export function projectResolver(world: ProjectWorld): ProjectResolver {
  return {
    async project(ownerId, refs, scope) {
      const owned = <T extends { ownerId?: string | undefined }>(list: readonly T[]) => list.filter((entry) => entry.ownerId === ownerId);
      const projects = owned(await world.projects());
      const found = (id: string | undefined): ProjectResolution | undefined => {
        const project = id ? projects.find((entry) => entry.id === id) : undefined;
        return project ? { project: { id: project.id, ownerId } } : undefined;
      };
      const trees = async () => owned(await world.trees());
      const projectOfTree = async (treeId: string | undefined) => (await trees()).find((tree) => tree.id === treeId)?.projectIds?.[0];
      const projectOfBranch = async (branchId: string | undefined) => projectOfTree(owned(await world.branches()).find((branch) => branch.id === branchId)?.treeId);
      const projectOfLeaf = async (leafId: string | undefined) => projectOfBranch(owned(await world.leaves()).find((leaf) => leaf.id === leafId)?.branchId);

      const named = text(refs.project);
      if (named) {
        const project = projects.find((entry) => entry.id === named) ?? projects.find((entry) => entry.name.toLowerCase() === named.toLowerCase() || entry.giteaRepo?.toLowerCase() === named.toLowerCase());
        return found(project?.id) ?? { outside: 'project' };
      }
      if (refs.projectId !== undefined) return found(text(refs.projectId)) ?? { outside: 'projectId' };
      if (refs.treeId !== undefined) return found(await projectOfTree(text(refs.treeId))) ?? { outside: 'treeId' };
      if (refs.branchId !== undefined) return found(await projectOfBranch(text(refs.branchId))) ?? { outside: 'branchId' };
      if (refs.leafId !== undefined) return found(await projectOfLeaf(text(refs.leafId))) ?? { outside: 'leafId' };
      if (refs.leafIds !== undefined) {
        const ids = Array.isArray(refs.leafIds) ? refs.leafIds.map(text) : [undefined];
        const resolved = await Promise.all(ids.map((id) => projectOfLeaf(id)));
        const first = found(resolved[0]);
        return first && resolved.every((id) => id === resolved[0]) ? first : { outside: 'leafIds' };
      }
      if (refs.taskId !== undefined) {
        const task = (await world.tasks(ownerId)).find((entry) => entry.id === text(refs.taskId));
        const id = task?.projectId ?? (task?.leafId ? await projectOfLeaf(task.leafId) : undefined);
        return found(id) ?? { outside: 'taskId' };
      }
      if (scope.projectId) return found(scope.projectId) ?? {};
      if (scope.treeId) return found(await projectOfTree(scope.treeId)) ?? {};
      if (scope.conversationId && world.conversation) {
        const conversation = await world.conversation(ownerId, scope.conversationId);
        return found(conversation?.projectId ?? (conversation?.treeId ? await projectOfTree(conversation.treeId) : undefined)) ?? {};
      }
      return {};
    },
  };
}
