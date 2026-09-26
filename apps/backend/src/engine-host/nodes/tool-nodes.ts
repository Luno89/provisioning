import { environmentFor, resolveToolSet, type AgentDefinition } from '@koala/agent-engine';
import {
  valueImplementation,
  type EnvironmentValue,
  type NodeImplementation,
} from '@koala/agent-engine/procedure';
import { capabilitiesOf } from '@koala/engine-core';
import type { HostNodeServices } from './services.js';

const allowedFrom = (settings: Readonly<Record<string, unknown>>): 'granted' | 'none' | string[] => {
  if (settings.offer === 'none') return 'none';
  if (settings.offer === 'chosen') {
    return Array.isArray(settings.chosen) ? settings.chosen.filter((name): name is string => typeof name === 'string') : [];
  }
  return 'granted';
};

export function createToolNodes(services: Pick<HostNodeServices, 'registry' | 'mcp'>): NodeImplementation[] {
  return [
    valueImplementation('resolve-tools', async ({ node, inputs, run }) => {
      const persona = inputs.persona as AgentDefinition;
      const environment = inputs.environment as EnvironmentValue | undefined;
      const capabilities = environment?.kind === 'sandbox'
        ? capabilitiesOf(environment.capabilities)
        : capabilitiesOf(environmentFor(persona));

      const mcp = services.mcp ? await services.mcp.forRun(run.launch.ownerId, persona, run.launch.conversationId) : undefined;
      const { tools, withheld } = resolveToolSet({
        agent: mcp ? { ...persona, tools: [...persona.tools, ...mcp.contracts.map((tool) => tool.name)] } : persona,
        callable: (inputs.delegates as AgentDefinition[] | undefined) ?? [],
        catalogue: [...await services.registry.tools(run.launch.ownerId), ...(mcp?.contracts ?? [])],
        capabilities,
        allowed: allowedFrom(node.settings),
      });

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
