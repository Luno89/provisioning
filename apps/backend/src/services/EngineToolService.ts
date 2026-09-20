import { placeholdersIn } from '@koala/engine-core';
import {
  checkDefinition,
  planFor,
  type Persona,
  type ToolDefinition,
} from '@koala/agent-engine';
import { withBuiltIns } from '../lib/ownership.js';
import type { ImageStanding } from '../engine-host/sandboxes/image-builder.js';

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
  personas: { list(ownerId?: string): Promise<Persona[]> };
  implemented: ReadonlySet<string>;
  images?: {
    start(plan: NonNullable<ReturnType<typeof planFor>>): Promise<ImageStanding>;
  } | undefined;
}

export type SaveToolOutcome =
  | { saved: true; tool: EditableTool; rebuilding: string[] }
  | { saved: false; problems: string[] };

const VIA = ['dnf', 'apt', 'pip', 'npm', 'script', 'base'];

export function toolProblems(
  value: unknown,
  known: { implemented: ReadonlySet<string> },
): string[] {
  if (typeof value !== 'object' || value === null) return ['a tool has to be an object'];
  const tool = value as Partial<ToolDefinition>;

  if (typeof tool.name !== 'string' || !tool.name.trim()) return ['the tool needs a name'];
  if (typeof tool.parameters !== 'object' || tool.parameters === null
    || typeof (tool.parameters as { properties?: unknown }).properties !== 'object') {
    return ['the tool has to say what arguments it takes, even if it takes none'];
  }

  const whole = { failures: [], status: 'draft', ...tool } as ToolDefinition;
  const problems = checkDefinition(whole).map((problem) => problem.message);

  if (!whole.command?.trim() && !known.implemented.has(whole.name)) {
    problems.push('nothing here runs this tool, so it needs a command to run in the workspace');
  }

  if (whole.install && !VIA.includes(whole.install.via)) {
    problems.push(`"${whole.install.via}" is not a way to install anything`);
  }
  if (whole.install?.via === 'script' && !whole.install.run.trim()) {
    problems.push('the install script is empty, so it would install nothing');
  }
  if (whole.install && whole.install.via !== 'script' && whole.install.via !== 'base'
    && whole.install.packages.length === 0) {
    problems.push('the install names no packages, so it would install nothing');
  }
  if (whole.install && !whole.needsBinaries?.length && whole.install.via !== 'base') {
    problems.push('it installs something but never says which binary that gives it');
  }

  return problems;
}

export class EngineToolService {
  private readonly options: EngineToolServiceOptions;

  constructor(options: EngineToolServiceOptions) {
    this.options = options;
  }

  private async visible(ownerId: string): Promise<ToolDefinition[]> {
    return withBuiltIns(await this.options.tools.list(ownerId), ownerId, (tool: ToolDefinition) => tool.name);
  }

  async list(ownerId: string): Promise<EditableTool[]> {
    const [tools, personas] = await Promise.all([this.visible(ownerId), this.options.personas.list(ownerId)]);

    return tools
      .map((tool) => ({
        ...tool,
        mine: tool.ownerId === ownerId,
        grantedTo: personas.filter((persona) => persona.tools?.includes(tool.name)).map((persona) => persona.slug),
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
    const problems = toolProblems(input, { implemented: this.options.implemented });
    if (problems.length > 0) return { saved: false, problems };

    const tool: ToolDefinition = { ...(input as ToolDefinition), ownerId };
    await this.options.tools.save(tool);

    return { saved: true, tool: { ...tool, mine: true, grantedTo: [] }, rebuilding: await this.rebuild(ownerId, tool.name) };
  }

  async remove(ownerId: string, name: string): Promise<boolean> {
    const mine = (await this.options.tools.list(ownerId)).find((tool) => tool.name === name && tool.ownerId === ownerId);
    if (!mine) return false;

    await this.options.tools.remove(ownerId, name);
    await this.rebuild(ownerId, name);
    return true;
  }

  private async rebuild(ownerId: string, name: string): Promise<string[]> {
    if (!this.options.images) return [];

    const [tools, personas] = await Promise.all([this.visible(ownerId), this.options.personas.list(ownerId)]);
    const affected = personas.filter((persona) => persona.tools?.includes(name));
    const started: string[] = [];

    for (const persona of affected) {
      const plan = planFor(persona, tools);
      if (!plan) continue;

      const standing = await this.options.images.start(plan).catch(() => undefined);
      if (standing?.state === 'building') started.push(persona.slug);
    }

    return started;
  }
}
