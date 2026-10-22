import { agentsHandedTo, describeOutline, outlineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { builtLanguage, groveAgentOf, resolveTreeType, treeLanguage, type TreeTypeSpec } from '../lib/tree-types.js';
import { describeTreeType, type ReleaseWay, type ReleaseWays } from '../lib/tree-type-description.js';
import { releaseHowOf } from '../../releases/lib/release-run.js';
import { CHART_FILE } from '../../releases/lib/odoo-release.js';
import type { ReleaseAgent } from '../../releases/services/ReleaseSettings.js';
import type { WorkspaceImageSpec } from '../../engine/index.js';

export interface TreeTypeDescriptionDeps {
  treeTypes: (ownerId: string) => Promise<TreeTypeSpec[]>;
  images: (ownerId: string) => Promise<WorkspaceImageSpec[]>;
  agentOf: (ownerId: string, agent: string) => Promise<{ describe?: string | undefined; procedure?: Procedure | undefined } | undefined>;
  releaseAgents?: ((ownerId: string) => Promise<ReleaseAgent[]>) | undefined;
  restores?: ((app: string) => { title: string } | undefined) | undefined;
  dependencies?: ((ownerId: string) => Promise<readonly { name: string; summary: string; provides: string[] }[]>) | undefined;
}

export class TreeTypeDescriptions {
  constructor(private readonly deps: TreeTypeDescriptionDeps) {}

  async describe(ownerId: string, typeId: string): Promise<string | undefined> {
    const type = await resolveTreeType({ getTreeTypes: () => this.deps.treeTypes(ownerId) }, ownerId, typeId);
    if (!type) return undefined;
    const [images, growing, releasing, dependencies] = await Promise.all([this.deps.images(ownerId), this.growing(ownerId, groveAgentOf(type)), this.releasing(ownerId, type), this.deps.dependencies?.(ownerId) ?? []]);
    const image = images.find((entry) => entry.id === builtLanguage(treeLanguage(type, { version: type.versions?.default })));
    const has = new Set((image?.available ?? []).map((entry) => entry.split(' ')[0]!));
    const canGet = dependencies.filter((dependency) => dependency.provides.length === 0 || !dependency.provides.every((program) => has.has(program))).map(({ name, summary }) => ({ name, summary }));
    return describeTreeType({ type, image, growing, releasing, canGet });
  }

  async releasingOf(ownerId: string, typeId: string): Promise<ReleaseWays | undefined> {
    const type = await resolveTreeType({ getTreeTypes: () => this.deps.treeTypes(ownerId) }, ownerId, typeId);
    return type ? this.releasing(ownerId, type) : undefined;
  }

  async releasing(ownerId: string, type: TreeTypeSpec): Promise<ReleaseWays | undefined> {
    if (!this.deps.releaseAgents || type.produces === 'artefact') return undefined;
    const own = releaseHowOf({}, type, type.files.some((file) => file.path === CHART_FILE));
    const agents = await this.deps.releaseAgents(ownerId);
    const beside = Boolean(own.app);
    const named = (slug: string, app?: string | undefined): ReleaseWay => {
      const agent = agents.find((entry) => entry.slug === slug);
      return { slug, name: agent?.name ?? slug, ...(agent?.description ? { description: agent.description } : {}), ...(app ? { app } : {}) };
    };
    return {
      own: named(own.agent, own.app),
      others: agents.filter((agent) => agent.slug !== own.agent && agent.needsApp === beside).map((agent) => named(agent.slug, beside ? own.app : undefined)),
      ...(own.app && this.deps.restores?.(own.app) ? { restores: this.deps.restores(own.app)! } : {}),
    };
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
