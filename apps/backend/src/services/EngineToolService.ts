import { placeholdersIn } from '@koala/engine-core';
import {
  checkDefinition,
  planFor,
  visibleAgents,
  type Persona,
  type ToolDefinition,
  type WorkspaceDependency,
} from '@koala/agent-engine';
import { SHIPPED_DEPENDENCIES } from '../extensions/workspace-dependencies.js';
import { unknownNeeds, unknownNeedsSaid } from '../lib/workspace-dependencies.js';
import type { AgentDirectory } from '../engine-host/registries/agent-directory.js';
import { withBuiltIns } from '../lib/ownership.js';
import type { ImageStanding } from '../engine-host/sandboxes/image-builder.js';
import { planWorkspace } from '../extensions/workspace-bases.js';
import type { McpServerRecord } from '../lib/mcp-servers.js';

export interface EditableTool extends ToolDefinition {
  mine: boolean;
  grantedTo: string[];
}

export interface EngineToolServiceOptions {
  tools: {
    list(ownerId?: string): Promise<ToolDefinition[]>;
    save(tool: ToolDefinition): Promise<void>;
    remove(ownerId: string | undefined, name: string): Promise<void>;
  };
  agents: AgentDirectory;
  catalogue?: { list(ownerId: string): Promise<ToolDefinition[]> } | undefined;
  servers?: ((ownerId: string) => Promise<readonly McpServerRecord[]>) | undefined;
  dependencies?: ((ownerId: string) => Promise<readonly WorkspaceDependency[]>) | undefined;
  implemented: ReadonlySet<string>;
  images?: {
    start(plan: NonNullable<ReturnType<typeof planFor>>): Promise<ImageStanding>;
  } | undefined;
}

export interface WorkspaceBuildFailure {
  agent: string;
  detail: string;
}

export type SaveToolOutcome =
  | { saved: true; tool: EditableTool; rebuilding: string[]; failed: WorkspaceBuildFailure[] }
  | { saved: false; problems: string[] };

export function toolProblems(
  value: unknown,
  known: { implemented: ReadonlySet<string>; dependencies?: readonly WorkspaceDependency[] | undefined },
): string[] {
  if (typeof value !== 'object' || value === null) return ['a tool has to be an object'];
  const tool = value as Partial<ToolDefinition>;

  if (typeof tool.name !== 'string' || !tool.name.trim()) return ['the tool needs a name'];
  if (typeof tool.parameters !== 'object' || tool.parameters === null
    || typeof (tool.parameters as { properties?: unknown }).properties !== 'object') {
    return ['the tool has to say what arguments it takes, even if it takes none'];
  }

  const whole = { failures: [], ...tool } as ToolDefinition;
  const problems = checkDefinition(whole).map((problem) => problem.message);

  if (!whole.command?.trim() && !known.implemented.has(whole.name)) {
    problems.push('nothing here runs this tool, so it needs a command to run in the workspace; an MCP server is added to the catalogue of MCP servers instead');
  }

  if (whole.needs !== undefined && (!Array.isArray(whole.needs) || whole.needs.some((need) => typeof need !== 'string'))) {
    problems.push('needs has to be a list of dependency names');
  } else {
    const catalogue = known.dependencies ?? SHIPPED_DEPENDENCIES;
    const unknown = unknownNeeds(whole.needs, catalogue);
    if (unknown.length) problems.push(unknownNeedsSaid(unknown, catalogue));
  }

  return problems;
}

export class EngineToolService {
  private readonly options: EngineToolServiceOptions;

  constructor(options: EngineToolServiceOptions) {
    this.options = options;
  }

  private async agents(ownerId: string): Promise<Persona[]> {
    return visibleAgents(await this.options.agents.agents(ownerId, { withHidden: true }), ownerId);
  }

  private async visible(ownerId: string): Promise<ToolDefinition[]> {
    if (this.options.catalogue) return this.options.catalogue.list(ownerId);
    return withBuiltIns(await this.options.tools.list(ownerId), ownerId, (tool: ToolDefinition) => tool.name);
  }

  async list(ownerId: string): Promise<EditableTool[]> {
    const [tools, personas] = await Promise.all([this.visible(ownerId), this.agents(ownerId)]);

    return tools
      .map((tool) => ({
        ...tool,
        mine: tool.ownerId === ownerId,
        grantedTo: personas.filter((persona) => persona.tools.includes(tool.name)).map((persona) => persona.slug),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(ownerId: string, name: string): Promise<EditableTool | undefined> {
    return (await this.list(ownerId)).find((tool) => tool.name === name);
  }

  blanks(tool: Pick<ToolDefinition, 'command'>): string[] {
    return tool.command ? placeholdersIn(tool.command) : [];
  }

  async save(ownerId: string, input: unknown): Promise<SaveToolOutcome> {
    const problems = toolProblems(input, { implemented: this.options.implemented, dependencies: await this.dependencies(ownerId) });
    if (problems.length > 0) return { saved: false, problems };

    const tool: ToolDefinition = { ...(input as ToolDefinition), ownerId };
    await this.options.tools.save(tool);

    return {
      saved: true,
      tool: { ...tool, mine: true, grantedTo: [] },
      ...(await this.rebuild(ownerId, tool.name)),
    };
  }

  async remove(ownerId: string, name: string): Promise<boolean> {
    const mine = (await this.options.tools.list(ownerId)).find((tool) => tool.name === name && tool.ownerId === ownerId);
    if (!mine) return false;

    const holders = await this.holders(ownerId, name);
    await this.options.tools.remove(ownerId, name);
    if (!(await this.visible(ownerId)).some((tool) => tool.name === name)) await this.options.agents.forgetTool(ownerId, name);
    await this.rebuild(ownerId, name, holders);
    return true;
  }

  private async dependencies(ownerId: string): Promise<readonly WorkspaceDependency[]> {
    return this.options.dependencies ? this.options.dependencies(ownerId) : SHIPPED_DEPENDENCIES;
  }

  async rebuildNeeding(ownerId: string, tools: readonly string[]): Promise<{ rebuilding: string[]; failed: WorkspaceBuildFailure[] }> {
    const personas = await this.agents(ownerId);
    const held = personas.filter((persona) => persona.tools.some((tool) => tools.includes(tool))).map((persona) => persona.slug);
    return held.length ? this.rebuild(ownerId, tools[0]!, held) : { rebuilding: [], failed: [] };
  }

  private async holders(ownerId: string, name: string): Promise<string[]> {
    return (await this.agents(ownerId)).filter((persona) => persona.tools.includes(name)).map((persona) => persona.slug);
  }

  private async rebuild(ownerId: string, name: string, held?: readonly string[]): Promise<{ rebuilding: string[]; failed: WorkspaceBuildFailure[] }> {
    if (!this.options.images) return { rebuilding: [], failed: [] };

    const [tools, personas, servers, dependencies] = await Promise.all([this.visible(ownerId), this.agents(ownerId), this.options.servers?.(ownerId) ?? Promise.resolve([]), this.dependencies(ownerId)]);
    const wanted = new Set(held ?? personas.filter((persona) => persona.tools.includes(name)).map((persona) => persona.slug));
    const affected = personas.filter((persona) => wanted.has(persona.slug));
    const rebuilding: string[] = [];
    const failed: WorkspaceBuildFailure[] = [];

    for (const persona of affected) {
      let plan;
      try {
        plan = planWorkspace(persona, tools, servers, undefined, dependencies);
      } catch (err) {
        failed.push({ agent: persona.slug, detail: (err as Error).message });
        continue;
      }
      if (!plan) continue;

      // Taken the same way AgentService.save takes it: a workspace that cannot start building is
      // the person's business. Shrugging here leaves them to find out at the next run instead.
      const standing = await this.options.images.start(plan)
        .catch((err: Error) => ({ state: 'failed' as const, reference: '', detail: err.message }));

      if (standing.state === 'building') rebuilding.push(persona.slug);
      if (standing.state === 'failed') failed.push({ agent: persona.slug, detail: standing.detail ?? 'no reason given' });
    }

    return { rebuilding, failed };
  }
}
