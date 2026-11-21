import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@koala/agent-engine';
import { createAgentRegistry } from '../registries/registry.js';
import { grantHeld, grantsHeldInMemory } from '../../engine/testing/run-grants.js';
import { handOffProblem } from './hand-offs.js';

const agent = (slug: string, agents: string[] = []): AgentDefinition => ({
  slug, name: slug, description: slug, version: '1', prompt: 'p', procedure: 'tool-rounds', guidance: '', returns: '', failures: [], tools: [], environment: {}, agents,
});

async function world(agents: AgentDefinition[] | (() => AgentDefinition[])) {
  const grants = grantsHeldInMemory();
  const grantId = await grantHeld(grants, { ownerId: 'u1', runId: 'run-1' });
  const listed = typeof agents === 'function' ? agents : () => agents;
  const deps = { registry: createAgentRegistry({ agentStore: { list: async () => listed() }, toolCatalogue: { list: async () => [] } }), grants };
  const from = { ownerId: 'u1', agentSlug: 'asker', grantId };
  return { grants, deps, from };
}

describe('handing work to another agent', () => {
  it('runs only when the agent holds that hand-off and its run\'s grant is live', async () => {
    const { deps, from } = await world([agent('asker', ['helper']), agent('helper'), agent('other')]);
    expect(await handOffProblem(deps, from, 'helper')).toBeUndefined();
    expect(await handOffProblem(deps, from, 'other')).toBe('asker is not allowed to hand work to "other" — grant it the agent first');
  });

  it('is refused at once when the hand-off is taken from the agent mid-run', async () => {
    let agents = [agent('asker', ['helper']), agent('helper')];
    const { deps, from } = await world(() => agents);
    expect(await handOffProblem(deps, from, 'helper')).toBeUndefined();
    agents = [agent('asker'), agent('helper')];
    expect(await handOffProblem(deps, from, 'helper')).toBe('asker is not allowed to hand work to "helper" — grant it the agent first');
  });

  it('is refused once the run\'s access was revoked, by the same check every tool call meets', async () => {
    const { grants, deps, from } = await world([agent('asker', ['helper']), agent('helper')]);
    await grants.revokeGrantsOf({ personId: 'u1', because: 'signed-out-everywhere' });
    expect(await handOffProblem(deps, from, 'helper')).toMatch(/access was revoked because they signed out everywhere, so it may not use helper/);
  });

  it('is refused for an agent that is not there', async () => {
    const { deps, from } = await world([agent('helper')]);
    expect(await handOffProblem(deps, from, 'helper')).toBe('There is no agent called "asker".');
  });
});
