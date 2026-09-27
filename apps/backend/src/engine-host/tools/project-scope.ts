import { primaryProjectId, type Tree } from '../../lib/trees.js';
import type { ProjectMetadata } from '../../lib/types.js';

export interface ProjectScopeStores {
  projects: { list(): Promise<ProjectMetadata[]> };
  trees: { list(): Promise<Tree[]> };
  binding?: ((ownerId: string, conversationId: string) => Promise<{ treeId?: string | undefined; projectId?: string | undefined } | undefined>) | undefined;
}

export type ScopedProject = { project: ProjectMetadata; treeId?: string | undefined } | { problem: string };

export async function projectFor(
  stores: ProjectScopeStores,
  ownerId: string,
  named: string | undefined,
  caller: { projectId?: string | undefined; conversationId?: string | undefined },
): Promise<ScopedProject> {
  const binding = caller.conversationId && stores.binding ? await stores.binding(ownerId, caller.conversationId) : undefined;
  const trees = (await stores.trees.list()).filter((tree) => tree.ownerId === ownerId);
  const boundTree = binding?.treeId ? trees.find((tree) => tree.id === binding.treeId) : undefined;
  const mine = (await stores.projects.list()).filter((project) => project.ownerId === ownerId);

  let project: ProjectMetadata | undefined;
  if (named) {
    const needle = named.toLowerCase();
    project = mine.find((candidate) => candidate.id === named || candidate.name.toLowerCase() === needle || candidate.giteaRepo === named);
    if (!project) {
      const names = mine.map((candidate) => candidate.name).join(', ') || 'none';
      return { problem: `no such project: ${named} — yours are: ${names}` };
    }
  } else {
    const id = caller.projectId ?? binding?.projectId ?? (boundTree ? primaryProjectId(boundTree) : undefined);
    if (!id) {
      return { problem: 'this run is about none of your projects — name the projectId, or ask once approving the plan has created the project' };
    }
    project = mine.find((candidate) => candidate.id === id);
    if (!project) return { problem: `no such project: ${id}` };
  }

  const owningTree = boundTree ?? trees.find((tree) => tree.projectIds?.includes(project!.id));
  return { project, ...(owningTree ? { treeId: owningTree.id } : {}) };
}
