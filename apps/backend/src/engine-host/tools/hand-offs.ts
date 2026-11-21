import type { GrantCheck } from '../../engine/index.js';
import type { AgentRegistry } from '../registries/registry.js';
import type { RunTicket } from '../temporal/contracts.js';

export interface HandOffChecks {
  registry: Pick<AgentRegistry, 'agent'>;
  grants: { check(grantId: string, tool: string, projectId: string | undefined): Promise<GrantCheck> };
}

export async function handOffProblem(deps: HandOffChecks, from: Pick<RunTicket, 'ownerId' | 'agentSlug' | 'grantId' | 'projectId'>, to: string): Promise<string | undefined> {
  const caller = await deps.registry.agent(from.ownerId, from.agentSlug);
  if (!caller) return `There is no agent called "${from.agentSlug}".`;
  if (!(caller.agents ?? []).includes(to)) return `${caller.slug} is not allowed to hand work to "${to}" — grant it the agent first`;
  const checked = await deps.grants.check(from.grantId, to, from.projectId);
  return 'problem' in checked ? checked.problem : undefined;
}
