import { environmentFor, resolveToolSet, type AgentDefinition } from '@koala/agent-engine';
import {
  valueImplementation,
  type EnvironmentValue,
  type NodeImplementation,
} from '@koala/agent-engine/procedure';
import { capabilitiesOf } from '@koala/engine-core';
import { handleFor, ticketFor, type HostNodeServices } from './services.js';

const allowedFrom = (settings: Readonly<Record<string, unknown>>): 'granted' | 'none' | string[] => {
  if (settings.offer === 'none') return 'none';
  if (settings.offer === 'chosen') {
    return Array.isArray(settings.chosen) ? settings.chosen.filter((name): name is string => typeof name === 'string') : [];
  }
  return 'granted';
};

export function createToolNodes(services: Pick<HostNodeServices, 'registry' | 'serverTools'>): NodeImplementation[] {
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
      const tools = [...resolved.tools, ...chosen];
      const withheld = [...resolved.withheld, ...fromServers.withheld];

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
