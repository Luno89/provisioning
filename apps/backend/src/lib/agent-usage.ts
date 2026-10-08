import { groupLibrary, type GroupDefinition, type Procedure } from '@koala/agent-engine/procedure';
import type { Persona } from '@koala/agent-engine';
import { DEFAULT_CHAT_AGENT, MEMORY_KEEPER } from './conclusions.js';
import { groveAgentOf } from './tree-types.js';

export const PROCEDURE_CHANGE_AGENT = 'agent-builder';
export const CONVERSATION_PROCEDURE = 'interactive-chat';

export type UsageKind = 'chat' | 'platform' | 'tree-type' | 'procedure' | 'hand-off';

export interface AgentUsage {
  kind: UsageKind;
  by: string;
}

const PLATFORM: readonly { slug: string; why: string }[] = [
  { slug: MEMORY_KEEPER, why: 'remembers what concluded conversations, judged work and failed runs leave' },
  { slug: PROCEDURE_CHANGE_AGENT, why: 'makes the procedure changes you hand it' },
];

export function agentsNamedIn(procedure: Pick<Procedure, 'nodes' | 'groups'>, shared: readonly GroupDefinition[] = []): string[] {
  const library = groupLibrary(procedure, shared);
  const seen = new Set<string>();
  const named = new Set<string>();
  const walk = (nodes: Procedure['nodes']): void => {
    for (const node of nodes) {
      if (typeof node.settings.agent === 'string' && node.settings.agent) named.add(node.settings.agent);
      if (node.group && !seen.has(node.group)) {
        seen.add(node.group);
        const group = library.get(node.group);
        if (group) walk(group.nodes);
      }
    }
  };
  walk(procedure.nodes);
  return [...named].sort();
}

export function agentUsage(input: {
  agents: readonly Pick<Persona, 'slug' | 'procedure' | 'agents'>[];
  procedures: readonly Procedure[];
  treeTypes: readonly { id: string; label: string; agent?: string | undefined }[];
  groups?: readonly GroupDefinition[] | undefined;
}): Map<string, AgentUsage[]> {
  const usage = new Map<string, AgentUsage[]>(input.agents.map((agent) => [agent.slug, []]));
  const add = (slug: string, entry: AgentUsage) => usage.get(slug)?.push(entry);

  for (const agent of input.agents) {
    if (agent.slug === DEFAULT_CHAT_AGENT) add(agent.slug, { kind: 'chat', by: 'every new conversation' });
    else if (agent.procedure === CONVERSATION_PROCEDURE) add(agent.slug, { kind: 'chat', by: 'conversations started with it' });
    for (const other of agent.agents ?? []) add(other, { kind: 'hand-off', by: agent.slug });
  }
  for (const { slug, why } of PLATFORM) add(slug, { kind: 'platform', by: why });
  for (const type of input.treeTypes) add(groveAgentOf(type), { kind: 'tree-type', by: type.label });
  for (const procedure of input.procedures) {
    for (const slug of agentsNamedIn(procedure, input.groups)) add(slug, { kind: 'procedure', by: procedure.id });
  }
  return usage;
}
