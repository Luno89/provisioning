import type { ToolDefinition, WorkspaceDependency } from '@koala/agent-engine';
import { SHIPPED_DEPENDENCIES } from '../extensions/workspace-dependencies.js';
import { catalogueOf, hasScript, ownDependencyProblems } from '../lib/workspace-dependencies.js';
import type { McpServerRecord } from '../lib/mcp-servers.js';
import { HOST_OPERATIONS } from '../extensions/installed.js';

export interface DependencyUse {
  tools: string[];
  servers: string[];
  dependencies: string[];
  steps: string[];
  trees: { id: string; name: string }[];
}

export interface DependencyView extends WorkspaceDependency {
  mine: boolean;
  script: boolean;
  usedBy: DependencyUse;
}

export interface WorkspaceDependencyDeps {
  store: {
    getWorkspaceDependencies(ownerId: string): Promise<WorkspaceDependency[]>;
    saveWorkspaceDependency(dependency: WorkspaceDependency & { ownerId: string }): Promise<void>;
    deleteWorkspaceDependency(ownerId: string, name: string): Promise<void>;
  };
  tools: (ownerId: string) => Promise<readonly ToolDefinition[]>;
  servers: (ownerId: string) => Promise<readonly McpServerRecord[]>;
  workspaces?: ((ownerId: string) => Promise<readonly { treeId: string; treeName?: string | undefined; file: { needs?: string[] | undefined } }[]>) | undefined;
  steps?: readonly { title: string; needs?: readonly string[] | undefined }[] | undefined;
  shipped?: readonly WorkspaceDependency[] | undefined;
  changed?: ((ownerId: string, name: string, use: DependencyUse) => Promise<void>) | undefined;
}

export type SaveDependencyOutcome = { saved: true; dependency: DependencyView } | { saved: false; problems: string[] };
export type RemoveDependencyOutcome = { removed: true } | { removed: false; why: string };

export class WorkspaceDependencyService {
  constructor(private readonly deps: WorkspaceDependencyDeps) {}

  private get shipped(): readonly WorkspaceDependency[] {
    return this.deps.shipped ?? SHIPPED_DEPENDENCIES;
  }

  async catalogue(ownerId: string): Promise<WorkspaceDependency[]> {
    return catalogueOf(this.shipped, await this.deps.store.getWorkspaceDependencies(ownerId));
  }

  private async uses(ownerId: string, catalogue: readonly WorkspaceDependency[]): Promise<(name: string) => DependencyUse> {
    const [tools, servers, workspaces] = await Promise.all([this.deps.tools(ownerId), this.deps.servers(ownerId), this.deps.workspaces?.(ownerId) ?? []]);
    return (name) => ({
      tools: tools.filter((tool) => tool.needs?.includes(name)).map((tool) => tool.name).sort(),
      servers: servers.filter((server) => server.runs.where === 'workspace' && server.runs.needs.includes(name)).map((server) => server.name).sort(),
      dependencies: catalogue.filter((dependency) => dependency.needs?.includes(name)).map((dependency) => dependency.name).sort(),
      steps: (this.deps.steps ?? HOST_OPERATIONS).filter((step) => step.needs?.includes(name)).map((step) => step.title).sort(),
      trees: workspaces.filter((workspace) => workspace.file.needs?.includes(name)).map((workspace) => ({ id: workspace.treeId, name: workspace.treeName ?? workspace.treeId })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  async list(ownerId: string): Promise<DependencyView[]> {
    const catalogue = await this.catalogue(ownerId);
    const usedBy = await this.uses(ownerId, catalogue);
    return catalogue
      .map((dependency) => ({ ...dependency, mine: dependency.ownerId === ownerId, script: hasScript(dependency), usedBy: usedBy(dependency.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(ownerId: string, input: WorkspaceDependency): Promise<SaveDependencyOutcome> {
    const dependency: WorkspaceDependency = {
      name: input.name,
      summary: input.summary?.trim() ?? '',
      provides: [...(input.provides ?? [])],
      ...(input.libraries?.length ? { libraries: [...input.libraries] } : {}),
      ...(input.needs?.length ? { needs: [...input.needs] } : {}),
      install: [...(input.install ?? [])],
      ...(input.onDebian?.length ? { onDebian: [...input.onDebian] } : {}),
      ownerId,
    };
    const own = await this.deps.store.getWorkspaceDependencies(ownerId);
    const problems = ownDependencyProblems(dependency, this.shipped, own);
    if (problems.length) return { saved: false, problems };
    await this.deps.store.saveWorkspaceDependency({ ...dependency, ownerId });
    const catalogue = await this.catalogue(ownerId);
    const usedBy = await this.uses(ownerId, catalogue);
    const use = usedBy(dependency.name);
    const reached = new Set([dependency.name]);
    for (let grew = true; grew;) {
      grew = false;
      for (const entry of catalogue) {
        if (!reached.has(entry.name) && (entry.needs ?? []).some((need) => reached.has(need))) { reached.add(entry.name); grew = true; }
      }
    }
    const all = [...reached].map(usedBy);
    const merged: DependencyUse = {
      tools: [...new Set(all.flatMap((one) => one.tools))].sort(),
      servers: [...new Set(all.flatMap((one) => one.servers))].sort(),
      dependencies: [...reached].filter((name) => name !== dependency.name).sort(),
      steps: [...new Set(all.flatMap((one) => one.steps))].sort(),
      trees: [...new Map(all.flatMap((one) => one.trees).map((tree) => [tree.id, tree])).values()],
    };
    await this.deps.changed?.(ownerId, dependency.name, merged);
    return { saved: true, dependency: { ...dependency, mine: true, script: hasScript(dependency), usedBy: use } };
  }

  async remove(ownerId: string, name: string): Promise<RemoveDependencyOutcome> {
    const own = await this.deps.store.getWorkspaceDependencies(ownerId);
    if (!own.some((dependency) => dependency.name === name)) {
      return { removed: false, why: this.shipped.some((dependency) => dependency.name === name) ? `${name} is one Koala ships` : `you have no dependency called ${name}` };
    }
    const use = (await this.uses(ownerId, await this.catalogue(ownerId)))(name);
    const users = [...use.tools.map((tool) => `the tool ${tool}`), ...use.servers.map((server) => `the MCP server ${server}`), ...use.dependencies.map((other) => `the dependency ${other}`), ...use.steps.map((step) => `the step ${step}`), ...use.trees.map((tree) => `the workspace of tree ${tree.name}`)];
    if (users.length) return { removed: false, why: `${name} is still needed by ${users.join(', ')}` };
    await this.deps.store.deleteWorkspaceDependency(ownerId, name);
    return { removed: true };
  }
}
