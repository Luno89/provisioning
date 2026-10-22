import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { Tree } from '../lib/trees.js';
import { resolveTreeType, treeLanguage, type TreeTypeSpec } from '../lib/tree-types.js';
import { needsProject, projectIdForTree, repoNameFor } from '../lib/tree-home.js';
import type { NewProject } from './ProjectRepoService.js';

export interface TreeHomeDeps {
  treeTypes: (ownerId: string) => Promise<TreeTypeSpec[]>;
  projects: () => Promise<ProjectMetadata[]>;
  createProject: (ownerId: string, project: NewProject) => Promise<ProjectMetadata>;
  starter: (type: TreeTypeSpec, tree: Tree) => Promise<{ path: string; content: string }[]>;
  saveTree: (tree: Tree) => Promise<void>;
  secrets?: { ensure(project: ProjectMetadata, options: { type: TreeTypeSpec }): Promise<unknown> } | undefined;
  saveNeeds?: ((project: ProjectMetadata, needs: { service: string; as?: string }[]) => Promise<unknown>) | undefined;
  channel?: ((project: ProjectMetadata) => Promise<unknown>) | undefined;
}

export function dependsOn(project: Pick<ProjectMetadata, 'needs'>, type: Pick<TreeTypeSpec, 'defaultBindings'>): { service: string; as?: string }[] | undefined {
  const have = project.needs ?? [];
  const missing = (type.defaultBindings ?? []).filter((service) => !have.some((need) => need.service === service));
  return missing.length ? [...have, ...missing.map((service) => ({ service }))] : undefined;
}

export class TreeHomeService {
  constructor(private readonly deps: TreeHomeDeps) {}

  async home(tree: Tree, options: { starter?: boolean } = {}): Promise<Tree> {
    const type = await resolveTreeType({ getTreeTypes: () => this.deps.treeTypes(tree.ownerId) }, tree.ownerId, tree.type);
    if (!type || !needsProject(type, tree)) return tree;

    const id = projectIdForTree(tree.id);
    const mine = (await this.deps.projects()).filter((project) => project.ownerId === tree.ownerId);
    const started = mine.find((project) => project.id === id);
    const project = await this.deps.createProject(tree.ownerId, {
      id,
      name: tree.name,
      repo: started?.giteaRepo ?? repoNameFor(tree.name, new Set(mine.map((entry) => entry.giteaRepo).filter((repo): repo is string => Boolean(repo)))),
      language: treeLanguage(type, tree),
      autoDeployOnBuild: true,
      description: `${tree.name} — the repository of tree ${tree.id}`,
      ...(options.starter === false ? {} : { starter: await this.deps.starter(type, tree) }),
    });
    const homed: Tree = { ...tree, projectIds: [project.id], updatedAt: new Date().toISOString() };
    await this.deps.saveTree(homed);
    const needs = dependsOn(project, type);
    if (needs) await this.deps.saveNeeds?.(project, needs);
    await this.deps.secrets?.ensure(project, { type });
    await this.deps.channel?.(project);
    return homed;
  }
}
