import { capabilitiesOf, effectiveTools, type ToolContract } from '@koala/engine-core';
import {
  environmentFor,
  isFork,
  LANGUAGE_IDS,
  planFor,
  toRecord,
  visibleAgents,
  type Persona,
  type PersonaRecord,
  type SourcedTool,
  type ToolDefinition,
  type ImageContent,
  type ImagePlan,
  type WorkspaceDependency,
} from '@koala/agent-engine';
import type { AgentDirectory, GrantMeta } from '../engine-host/registries/agent-directory.js';
import { sameSeededRow } from '../lib/seed-diff.js';
import { missingGrants, type Procedure } from '@koala/agent-engine/procedure';
import type { ImageStanding } from '../engine-host/sandboxes/image-builder.js';
import { platformGroups } from '../extensions/installed.js';
import { usesNode } from '../lib/procedure-reach.js';
import { agentUsage, type AgentUsage } from '../lib/agent-usage.js';
import { planWorkspace } from '../extensions/workspace-bases.js';
import type { McpServerRecord } from '../lib/mcp-servers.js';

export interface EditableAgent extends Persona {
  mine: boolean;
  recallsMemories: boolean;
  usedBy: AgentUsage[];
  toolSources: SourcedTool[];
  serverSources: SourcedTool[];
  image?: AgentImage | undefined;
}

export interface AgentImage extends ImageStanding {
  base?: string | undefined;
  contents?: ImageContent[] | undefined;
}

const withContents = (standing: ImageStanding, plan: ImagePlan): AgentImage => ({ ...standing, base: plan.base, contents: plan.contents ?? [] });

export interface AgentServiceOptions {
  agents: AgentDirectory;
  records: {
    save(record: PersonaRecord): Promise<void>;
    remove(ownerId: string | undefined, slug: string): Promise<void>;
  };
  tools(ownerId: string): Promise<ToolDefinition[]>;
  procedures(ownerId: string): Promise<readonly Procedure[]>;
  servers?: ((ownerId: string) => Promise<readonly McpServerRecord[]>) | undefined;
  dependencies?: ((ownerId: string) => Promise<readonly WorkspaceDependency[]>) | undefined;
  images?: {
    start(plan: NonNullable<ReturnType<typeof planFor>>): Promise<ImageStanding>;
    standing(plan: NonNullable<ReturnType<typeof planFor>>): Promise<ImageStanding>;
  } | undefined;
  treeTypes?: ((ownerId: string) => Promise<readonly { id: string; label: string; agent?: string | undefined }[]>) | undefined;
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
    personas?: readonly Persona[] | undefined;
    servers?: readonly string[] | undefined;
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
  if (agent.servers !== undefined && (!Array.isArray(agent.servers) || agent.servers.some((name) => typeof name !== 'string'))) {
    problems.push('the MCP servers it holds have to be a list of names');
  } else {
    for (const server of agent.servers ?? []) {
      if (!(known.servers ?? []).includes(server)) problems.push(`it holds "${server}", which is not one of your MCP servers`);
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
    const bySlug = new Map((known.personas ?? []).map((persona) => [persona.slug, persona]));
    const reachable: Persona[] = [];
    const queue = [...(whole.agents ?? [])];
    while (queue.length > 0) {
      const slug = queue.shift()!;
      const found = bySlug.get(slug);
      if (!found || slug === whole.slug || reachable.includes(found)) continue;
      reachable.push(found);
      queue.push(...(found.agents ?? []));
    }
    const shared = reachable.map(environmentFor).find((spec) => spec.kind === 'sandbox');
    const own = environmentFor(whole);
    const capabilities = capabilitiesOf(own.kind === 'none' && shared ? shared : own);
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

function recallsMemories(agent: Persona, procedures: readonly Procedure[]): boolean {
  const procedure = procedures.find((candidate) => candidate.id === agent.procedure);
  return procedure ? usesNode(procedure, 'recall-memory', platformGroups()) : false;
}

export class AgentService {
  private readonly options: AgentServiceOptions;

  constructor(options: AgentServiceOptions) {
    this.options = options;
  }

  private async all(ownerId: string): Promise<{ agents: Persona[]; sources: Record<string, SourcedTool[]>; serverSources: Record<string, SourcedTool[]> }> {
    const { agents, sources, serverSources } = await this.options.agents.sourced(ownerId, { withHidden: true });
    return { agents: visibleAgents(agents, ownerId), sources, serverSources };
  }

  private servers(ownerId: string): Promise<readonly McpServerRecord[]> {
    return this.options.servers?.(ownerId) ?? Promise.resolve([]);
  }

  private async planned(ownerId: string, agent: Persona, tools: readonly ToolDefinition[], servers: readonly McpServerRecord[]): Promise<ImagePlan | ImageStanding | undefined> {
    try {
      return planWorkspace(agent, tools, servers, undefined, this.options.dependencies ? await this.options.dependencies(ownerId) : undefined);
    } catch (err) {
      return { state: 'failed', reference: '', detail: (err as Error).message };
    }
  }

  private async started(ownerId: string, agent: Persona, tools: readonly ToolDefinition[], servers: readonly McpServerRecord[]): Promise<AgentImage | undefined> {
    const plan = await this.planned(ownerId, agent, tools, servers);
    if (!plan || 'state' in plan) return plan;
    if (!this.options.images) return undefined;
    const standing = await this.options.images.start(plan).catch((err: Error) => ({ state: 'failed' as const, reference: '', detail: err.message }));
    return withContents(standing, plan);
  }

  async grantable(ownerId: string): Promise<{ name: string; summary: string; binding: string; effect: ToolDefinition['effect']; needs: string[] }[]> {
    return (await this.options.tools(ownerId))
      .map((tool) => ({
        name: tool.name,
        summary: tool.summary,
        binding: tool.binding,
        effect: tool.effect,
        needs: Object.entries(tool.requires ?? {}).filter(([, wanted]) => wanted === true).map(([need]) => need),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(ownerId: string): Promise<EditableAgent[]> {
    const [{ agents, sources, serverSources }, tools, procedures, treeTypes, servers] = await Promise.all([
      this.all(ownerId), this.options.tools(ownerId), this.options.procedures(ownerId), this.options.treeTypes?.(ownerId) ?? [], this.servers(ownerId),
    ]);
    const usage = agentUsage({ agents, procedures, treeTypes, groups: platformGroups() });
    return Promise.all(agents
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(async (agent) => ({ ...agent, mine: isFork(agent), recallsMemories: recallsMemories(agent, procedures), usedBy: usage.get(agent.slug) ?? [], toolSources: sources[agent.slug] ?? [], serverSources: serverSources[agent.slug] ?? [], ...(await this.imageOf(ownerId, agent, tools, servers)) })));
  }

  async get(ownerId: string, slug: string): Promise<EditableAgent | undefined> {
    return (await this.list(ownerId)).find((agent) => agent.slug === slug);
  }

  private async imageOf(ownerId: string, agent: Persona, tools: readonly ToolDefinition[], servers: readonly McpServerRecord[]): Promise<{ image?: AgentImage }> {
    const plan = await this.planned(ownerId, agent, tools, servers);
    if (plan && 'state' in plan) return { image: plan };
    if (!plan || !this.options.images) return {};

    const image = await this.options.images.standing(plan).catch((err: Error) => ({
      state: 'failed' as const,
      reference: '',
      detail: err.message,
    }));

    return { image: withContents(image, plan) };
  }

  async image(ownerId: string, slug: string): Promise<AgentImage | undefined> {
    return (await this.get(ownerId, slug))?.image;
  }

  async holdServer(ownerId: string, slug: string, server: string, meta?: GrantMeta): Promise<ImageStanding | undefined> {
    const { agents } = await this.all(ownerId);
    const agent = agents.find((one) => one.slug === slug);
    if (!agent) throw new Error(`there is no agent called ${slug}`);
    if (!(agent.servers ?? []).includes(server)) await this.options.agents.setServers(ownerId, slug, [...(agent.servers ?? []), server], meta);
    const [tools, servers, { agents: after }] = await Promise.all([this.options.tools(ownerId), this.servers(ownerId), this.all(ownerId)]);
    return this.started(ownerId, after.find((one) => one.slug === slug) ?? agent, tools, servers);
  }

  async save(ownerId: string, input: unknown): Promise<SaveAgentOutcome> {
    const [tools, procedures, { agents }, servers] = await Promise.all([
      this.options.tools(ownerId),
      this.options.procedures(ownerId),
      this.all(ownerId),
      this.servers(ownerId),
    ]);

    const problems = agentProblems(input, {
      tools,
      procedures,
      agents: new Set(agents.map((agent) => agent.slug)),
      personas: agents,
      servers: servers.map((server) => server.name),
    });
    if (problems.length > 0) return { saved: false, problems };

    const wanted: Persona = { ...(input as Persona), ownerId };
    const builtIn = (await this.options.agents.agents(ownerId, { withHidden: true })).find((one) => one.slug === wanted.slug && one.ownerId === undefined);
    if (builtIn && sameSeededRow({ ...toRecord(builtIn), ownerId: undefined }, { ...toRecord(wanted), ownerId: undefined })) {
      await this.options.records.remove(ownerId, wanted.slug);
    } else {
      await this.options.records.save(toRecord(wanted));
    }
    await this.options.agents.setTools(ownerId, wanted.slug, wanted.tools ?? []);
    await this.options.agents.setServers(ownerId, wanted.slug, wanted.servers ?? []);
    const saved = await this.all(ownerId);
    const agent = saved.agents.find((one) => one.slug === wanted.slug) ?? wanted;

    const image = await this.started(ownerId, agent, tools, servers);

    const treeTypes = await this.options.treeTypes?.(ownerId) ?? [];
    const usage = agentUsage({ agents: [...agents.filter((one) => one.slug !== agent.slug), agent], procedures, treeTypes, groups: platformGroups() });
    return { saved: true, agent: { ...agent, mine: isFork(agent), recallsMemories: recallsMemories(agent, procedures), usedBy: usage.get(agent.slug) ?? [], toolSources: saved.sources[agent.slug] ?? [], serverSources: saved.serverSources[agent.slug] ?? [], ...(image ? { image } : {}) } };
  }

  async remove(ownerId: string, slug: string): Promise<boolean> {
    const { agents } = await this.options.agents.sourced(ownerId, { withHidden: true });
    if (!agents.some((agent) => agent.slug === slug && agent.ownerId === ownerId)) return false;

    await this.options.records.remove(ownerId, slug);
    await this.options.agents.forgetAgent(ownerId, slug);
    return true;
  }
}
