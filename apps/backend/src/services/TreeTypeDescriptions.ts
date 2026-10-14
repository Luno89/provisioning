import { agentsHandedTo, describeOutline, outlineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { groveAgentOf, resolveTreeType, treeLanguage, type TreeTypeSpec } from '../lib/tree-types.js';
import { describeTreeType } from '../lib/tree-type-description.js';
import type { WorkspaceImageSpec } from '../lib/workspace-image-seeds.js';

export interface TreeTypeDescriptionDeps {
  treeTypes: (ownerId: string) => Promise<TreeTypeSpec[]>;
  images: (ownerId: string) => Promise<WorkspaceImageSpec[]>;
  agentOf: (ownerId: string, agent: string) => Promise<{ describe?: string | undefined; procedure?: Procedure | undefined } | undefined>;
}

export class TreeTypeDescriptions {
  constructor(private readonly deps: TreeTypeDescriptionDeps) {}

  async describe(ownerId: string, typeId: string): Promise<string | undefined> {
    const type = await resolveTreeType({ getTreeTypes: () => this.deps.treeTypes(ownerId) }, ownerId, typeId);
    if (!type) return undefined;
    const [images, growing] = await Promise.all([this.deps.images(ownerId), this.growing(ownerId, groveAgentOf(type))]);
    return describeTreeType({ type, image: images.find((image) => image.id === treeLanguage(type, { version: type.versions?.default })), growing });
  }

  private async growing(ownerId: string, agent: string): Promise<string> {
    const grower = await this.deps.agentOf(ownerId, agent);
    if (!grower?.procedure) return `The ${agent} agent grows it, and this install has no procedure for it.`;
    const handed = new Map<string, Awaited<ReturnType<TreeTypeDescriptionDeps['agentOf']>>>();
    let next = agentsHandedTo(grower.procedure);
    for (let level = 0; level < 2 && next.length; level += 1) {
      const found = await Promise.all(next.filter((slug) => !handed.has(slug)).map(async (slug) => [slug, await this.deps.agentOf(ownerId, slug)] as const));
      for (const [slug, agent] of found) handed.set(slug, agent);
      next = found.flatMap(([, agent]) => (agent?.procedure ? agentsHandedTo(agent.procedure) : []));
    }
    return [
      `The ${agent} agent grows it${grower.describe ? ` — ${grower.describe}` : ''}. It runs:`,
      describeOutline(outlineProcedure(grower.procedure, (slug) => handed.get(slug))),
    ].join('\n');
  }
}
