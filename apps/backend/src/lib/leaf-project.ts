import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';
import type { ProjectMetadata } from './types.js';
import { DEFAULT_TARGET_CLUSTER } from './project-shipping.js';

export function autoRepoNameFor(branchId: string): string {
  return `koala-request-${branchId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

export interface LeafProjectDeps {
  treeProjectId?: string | undefined;
  db: Pick<Database, 'getProjects' | 'saveProject'>;
  ensureAccount: (ownerId: string) => Promise<{ username: string }>;
  repoExists: (username: string, name: string) => Promise<boolean>;
  createRepo: (username: string, name: string) => Promise<void>;
  newId: () => string;
}

export async function resolveLeafProject(deps: LeafProjectDeps, leaf: Leaf): Promise<ProjectMetadata> {
  const projects = await deps.db.getProjects();

  if (leaf.projectId) {
    const chosen = projects.find((p) => p.id === leaf.projectId && p.ownerId === leaf.ownerId);
    if (chosen) return chosen;
  }

  if (deps.treeProjectId) {
    const owned = projects.find((p) => p.id === deps.treeProjectId && p.ownerId === leaf.ownerId);
    if (owned) return owned;
  }

  const repo = autoRepoNameFor(leaf.branchId);
  const existing = projects.find((p) => p.ownerId === leaf.ownerId && p.giteaRepo === repo);
  if (existing) return existing;

  const account = await deps.ensureAccount(leaf.ownerId);

  if (!(await deps.repoExists(account.username, repo))) {
    try {
      await deps.createRepo(account.username, repo);
    } catch (err) {
      if (!(await deps.repoExists(account.username, repo))) throw err;
    }
  }

  const raced = (await deps.db.getProjects())
    .find((p) => p.ownerId === leaf.ownerId && p.giteaRepo === repo);
  if (raced) return raced;

  const project: ProjectMetadata = {
    id: deps.newId(),
    name: repo,
    ownerId: leaf.ownerId,
    giteaOwner: account.username,
    giteaRepo: repo,
    appType: 'gitapp',
    targetClusterId: DEFAULT_TARGET_CLUSTER,
    autoDeployOnBuild: true,
    createdAt: new Date().toISOString(),
  };
  try {
    await deps.db.saveProject(project);
  } catch (err) {
    const winner = (await deps.db.getProjects())
      .find((p) => p.ownerId === leaf.ownerId && p.giteaRepo === repo);
    if (!winner) throw err;
    return winner;
  }
  return project;
}
