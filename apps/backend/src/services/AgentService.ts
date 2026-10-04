import { capabilitiesOf, effectiveTools, type ToolContract } from '@koala/engine-core';
import {
  environmentFor,
  isFork,
  LANGUAGE_IDS,
  planFor,
  visibleAgents,
  type Persona,
  type ToolDefinition,
} from '@koala/agent-engine';
import { missingGrants, type Procedure } from '@koala/agent-engine/procedure';
import type { ImageStanding } from '../engine-host/sandboxes/image-builder.js';
import { seededPersonas } from '../extensions/seeds.js';
import { platformGroups } from '../extensions/installed.js';

export interface EditableAgent extends Persona {
  mine: boolean;
  image?: ImageStanding | undefined;
}

export interface AgentServiceOptions {
  personas: {
    list(ownerId?: string): Promise<Persona[]>;
    save(persona: Persona): Promise<void>;
    remove(ownerId: string | undefined, slug: string): Promise<void>;
  };
  tools(ownerId: string): Promise<ToolDefinition[]>;
  procedures(ownerId: string): Promise<readonly Procedure[]>;
  mcpServers?: ((ownerId: string) => Promise<string[]>) | undefined;
  images?: {
    start(plan: NonNullable<ReturnType<typeof planFor>>): Promise<ImageStanding>;
    standing(plan: NonNullable<ReturnType<typeof planFor>>): Promise<ImageStanding>;
  } | undefined;
  builtIn?: readonly Persona[] | undefined;
}

export type SaveAgentOutcome =
  | { saved: true; agent: EditableAgent }
  | { saved: false; problems: string[] };

const SLUG = /^[a-z][a-z0-9-]*$/;

export function agentProblems(
  value: unknown,
  known: {
    tools: readonly ToolDefinition[];
    procedures: readonly Procedure[];
    agents: ReadonlySet<string>;
    mcpServers?: readonly string[] | undefined;
  },
): string[] {
  if (typeof value !== 'object' || value === null) return ['an agent has to be an object'];
  const agent = value as Partial<Persona>;
  const problems: string[] = [];
  const toolNames = new Set(known.tools.map((tool) => tool.name));

  if (typeof agent.slug !== 'string' || !SLUG.test(agent.slug)) problems.push('the slug has to be lower-case words joined by dashes');
  if (typeof agent.name !== 'string' || !agent.name.trim()) problems.push('the agent needs a name');
  if (typeof agent.description !== 'string' || !agent.description.trim()) problems.push('the agent has to say what it is for');
  if (typeof agent.prompt !== 'string' || !agent.prompt.trim()) problems.push('the agent needs a prompt');

  const runs = known.procedures.find((procedure) => procedure.id === agent.procedure);
  if (typeof agent.procedure !== 'string' || !agent.procedure.trim()) problems.push('the agent has to name the procedure it runs');
  else if (!runs) problems.push(`there is no procedure called "${agent.procedure}"`);

  for (const missing of missingGrants(runs, { tools: agent.tools, agents: agent.agents }, platformGroups())) {
    problems.push(
      `${agent.procedure} needs it to have ${missing.kind === 'agent' ? 'the agent' : 'the tool'} `
      + `"${missing.name}" — ${missing.why}`,
    );
  }

  const EFFECTS = ['read', 'propose', 'write'];
  if (agent.concludeAfterMinutes !== undefined && !(typeof agent.concludeAfterMinutes === 'number' && agent.concludeAfterMinutes > 0)) {
    problems.push('a conversation concludes after a number of quiet minutes greater than zero; leave it blank for the default');
  }
  if (agent.maxEffect !== undefined && !EFFECTS.includes(agent.maxEffect)) {
    problems.push(`"${String(agent.maxEffect)}" is not a limit — an agent may be limited to read, propose or write`);
  }
  for (const tool of agent.tools ?? []) {
    const definition = known.tools.find((candidate) => candidate.name === tool);
    if (!toolNames.has(tool)) problems.push(`it is granted "${tool}", which is not a tool`);
    else if (agent.maxEffect && definition && EFFECTS.indexOf(definition.effect) > EFFECTS.indexOf(agent.maxEffect)) {
      problems.push(`it is granted "${tool}", which can ${definition.effect === 'write' ? 'change things' : 'propose changes'}, but the agent is limited to ${agent.maxEffect === 'read' ? 'reading' : 'proposing'}`);
    }
  }
  for (const delegate of agent.agents ?? []) {
    if (!known.agents.has(delegate)) problems.push(`it may hand work to "${delegate}", which is not an agent`);
  }
  if ((agent.agents ?? []).includes(agent.slug as string)) problems.push('an agent cannot hand work to itself');
  if (agent.mcp !== undefined && (!Array.isArray(agent.mcp) || agent.mcp.some((name) => typeof name !== 'string'))) {
    problems.push('the MCP servers it may use have to be a list of names');
  } else {
    for (const server of agent.mcp ?? []) {
      if (!(known.mcpServers ?? []).includes(server)) problems.push(`it may use "${server}", which is not one of your MCP servers`);
    }
  }

  for (const language of agent.environment?.languages ?? []) {
    if (!LANGUAGE_IDS.includes(language)) {
      problems.push(`"${language}" is not a language a workspace can ask for — it can ask for ${LANGUAGE_IDS.join(', ')}`);
    }
  }

  if (agent.model?.replyCeiling !== undefined && (!Number.isInteger(agent.model.replyCeiling) || agent.model.replyCeiling < 256)) {
    problems.push('the reply ceiling has to be a whole number of at least 256 tokens');
  }

  if (problems.length === 0) {
    const whole = agent as Persona;
    const capabilities = capabilitiesOf(environmentFor(whole));
    const granted = known.tools.filter((tool) => (whole.tools ?? []).includes(tool.name));
    const { withheld } = effectiveTools({
      granted: whole.tools ?? [],
      catalogue: granted as unknown as ToolContract[],
      capabilities,
    });

    for (const held of withheld) {
      problems.push(`it is granted "${held.name}", which cannot run in the workspace it asks for — ${held.why}`);
    }
  }

  return problems;
}

export class AgentService {
  private readonly options: AgentServiceOptions;

  constructor(options: AgentServiceOptions) {
    this.options = options;
  }

  private get builtIn(): readonly Persona[] {
    return this.options.builtIn ?? seededPersonas();
  }

  private async all(ownerId: string): Promise<Persona[]> {
    return visibleAgents([...this.builtIn, ...(await this.options.personas.list(ownerId))], ownerId);
  }

  async grantable(ownerId: string): Promise<{ name: string; summary: string; binding: string; needs: string[] }[]> {
    return (await this.options.tools(ownerId))
      .map((tool) => ({
        name: tool.name,
        summary: tool.summary,
        binding: tool.binding,
        needs: Object.entries(tool.requires ?? {}).filter(([, wanted]) => wanted === true).map(([need]) => need),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(ownerId: string): Promise<EditableAgent[]> {
    const [agents, tools] = await Promise.all([this.all(ownerId), this.options.tools(ownerId)]);

    return Promise.all(agents
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(async (agent) => ({ ...agent, mine: isFork(agent), ...(await this.imageOf(agent, tools)) })));
  }

  async get(ownerId: string, slug: string): Promise<EditableAgent | undefined> {
    return (await this.list(ownerId)).find((agent) => agent.slug === slug);
  }

  private async imageOf(agent: Persona, tools: readonly ToolDefinition[]): Promise<{ image?: ImageStanding }> {
    const plan = planFor(agent, tools);
    if (!plan || !this.options.images) return {};

    const image = await this.options.images.standing(plan).catch((err: Error) => ({
      state: 'failed' as const,
      reference: '',
      detail: err.message,
    }));

    return { image };
  }

  async save(ownerId: string, input: unknown): Promise<SaveAgentOutcome> {
    const [tools, procedures, agents, mcpServers] = await Promise.all([
      this.options.tools(ownerId),
      this.options.procedures(ownerId),
      this.all(ownerId),
      this.options.mcpServers?.(ownerId) ?? Promise.resolve([]),
    ]);

    const problems = agentProblems(input, {
      tools,
      procedures,
      agents: new Set(agents.map((agent) => agent.slug)),
      mcpServers,
    });
    if (problems.length > 0) return { saved: false, problems };

    const agent: Persona = { ...(input as Persona), ownerId };
    await this.options.personas.save(agent);

    const plan = planFor(agent, tools);
    const image = plan && this.options.images
      ? await this.options.images.start(plan).catch((err: Error) => ({ state: 'failed' as const, reference: '', detail: err.message }))
      : undefined;

    return { saved: true, agent: { ...agent, mine: true, ...(image ? { image } : {}) } };
  }

  async remove(ownerId: string, slug: string): Promise<boolean> {
    const mine = (await this.options.personas.list(ownerId)).find((agent) => agent.slug === slug && agent.ownerId === ownerId);
    if (!mine) return false;

    await this.options.personas.remove(ownerId, slug);
    return true;
  }
}
