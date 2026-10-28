import { environmentFor, resolveToolSet, type AgentDefinition } from '@koala/agent-engine';
import {
  valueImplementation,
  type EnvironmentValue,
  type NodeImplementation,
} from '@koala/agent-engine/procedure';
import { capabilitiesOf } from '@koala/engine-core';
import { handleFor, ticketFor, type HostNodeServices } from './services.js';
import { notesForRun, withLearned } from '../../engine/lib/tool-notes.js';
import { heldBackFromOthers } from '../../engine/lib/acting-for.js';
import { accessOf, offerable, withheldWhy } from '../../engine/lib/tool-access.js';
import { asPerson, memberPrincipal, type Principal } from '../../platform/lib/permissions.js';
import { isMcpToolName } from '../../engine/lib/mcp-tools.js';

const allowedFrom = (settings: Readonly<Record<string, unknown>>): 'granted' | 'none' | string[] => {
  if (settings.offer === 'none') return 'none';
  if (settings.offer === 'chosen') {
    return Array.isArray(settings.chosen) ? settings.chosen.filter((name): name is string => typeof name === 'string') : [];
  }
  return 'granted';
};

export function createToolNodes(services: Pick<HostNodeServices, 'registry' | 'serverTools'> & Partial<Pick<HostNodeServices, 'memories'>>): NodeImplementation[] {
  return [
    valueImplementation('resolve-tools', async ({ node, inputs, run }) => {
      const persona = inputs.persona as AgentDefinition;
      const environment = inputs.environment as EnvironmentValue | undefined;
      const capabilities = environment?.kind === 'sandbox'
        ? capabilitiesOf(environment.capabilities)
        : capabilitiesOf(environmentFor(persona));

      const allowed = allowedFrom(node.settings);
      const resolved = resolveToolSet({
        agent: persona,
        callable: (inputs.delegates as AgentDefinition[] | undefined) ?? [],
        catalogue: await services.registry.tools(run.launch.ownerId),
        capabilities,
        allowed,
      });
      const held = allowed === 'none' ? [] : persona.servers ?? [];
      const fromServers = services.serverTools && (held.length > 0 || run.launch.conversationId)
        ? await services.serverTools.forRun({ ticket: ticketFor(run), environment: handleFor(environment), held, ceiling: persona.maxEffect })
        : { tools: [], withheld: [] };
      const chosen = Array.isArray(allowed) ? fromServers.tools.filter((tool) => allowed.includes(tool.name)) : allowed === 'none' ? [] : fromServers.tools;
      const model = (inputs.binding as { model?: unknown } | undefined)?.model;
      const notes = services.memories ? notesForRun(await services.memories.list(run.launch.ownerId), typeof model === 'string' && model ? model : undefined) : undefined;
      const delegates = new Set(((inputs.delegates as AgentDefinition[] | undefined) ?? []).map((agent) => agent.slug));
      const principal = (run.launch.principal as Principal | undefined) ?? (run.launch.actingFor ? memberPrincipal(run.launch.actingFor.personId, run.launch.actingFor.projectId, run.launch.actingFor.role) : asPerson(run.launch.ownerId));
      const forMember = (tool: { name: string; effect?: string | undefined }) => (!run.launch.keptTo || !heldBackFromOthers(tool.name))
        && (delegates.has(tool.name) || offerable(accessOf(tool.name, tool, isMcpToolName(tool.name)), principal, run.launch.ownerId, run.launch.actingFor?.projectId ?? run.launch.projectId));
      const all = [...resolved.tools, ...chosen];
      const kept = all.filter(forMember);
      const tools = notes ? withLearned(kept, notes) : kept;
      const withheld = [
        ...resolved.withheld,
        ...fromServers.withheld,
        ...all.filter((tool) => !forMember(tool)).map((tool) => ({ name: tool.name, why: run.launch.keptTo && heldBackFromOthers(tool.name) ? 'people other than the owner talked in this conversation' : withheldWhy(run.launch.actingFor) })),
      ];

      const handled = run.handles ?? {};

      return {
        outputs: {
          offered: tools.filter((tool) => handled[tool.name] === undefined),
          withheld: [
            ...withheld,
            ...tools.filter((tool) => handled[tool.name] !== undefined)
              .map((tool) => ({ name: tool.name, why: handled[tool.name] as string })),
          ],
        },
      };
    }),
  ];
}
