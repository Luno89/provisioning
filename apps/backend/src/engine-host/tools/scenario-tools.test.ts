import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolHandlerContext } from '@koala/engine-core';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import type { ScenarioProposal } from '../../lib/scenario-proposals.js';
import { ENGINE_TOOL_SEEDS } from './engine-tool-seeds.js';
import { createScenarioTools } from './scenario-tools.js';
import { SCENARIO_TOOLS } from './scenario-tools-catalogue.js';

let saved: ScenarioProposal[];
let existing: string[];

const tools = () => createScenarioTools({
  known: async () => ({ agents: new Set(['koala']), procedures: new Set(['interactive-chat']), tools: [...BUILDER_TOOLS, ...ENGINE_TOOL_SEEDS] }),
  procedureOf: async (_ownerId, agent) => (agent === 'koala' ? 'interactive-chat' : undefined),
  scenarioIds: async () => existing,
  proposals: { list: async () => saved, save: async (proposal) => { saved.push(proposal); } },
  now: () => 'now',
});

const propose = (parsed: Record<string, unknown>) =>
  tools().propose_scenario!({ name: 'propose_scenario', parsed, driver: undefined, caller: { ownerId: 'u1', runId: 'memory-run-1', agentSlug: 'memory-keeper' } } as ToolHandlerContext);

const GOOD = {
  agent: 'koala',
  name: 'Checks tasks before planning',
  checks: 'It looks at the open tasks before saying what to do next.',
  message: 'What should I work on next?',
  toolsCalled: ['list_tasks'],
  why: 'In run r-9 it guessed without looking, and the person corrected it.',
};

beforeEach(() => {
  saved = [];
  existing = [];
});

describe('propose_scenario', () => {
  it('queues a test for the person, run on the agent\'s own procedure, noting why and which run proposed it', async () => {
    const out = await propose(GOOD);

    expect(out).toMatchObject({ ok: true, digest: 'proposed koala-checks-tasks-before-planning' });
    expect(saved).toEqual([{
      id: 'koala-checks-tasks-before-planning',
      ownerId: 'u1',
      status: 'proposed',
      why: GOOD.why,
      proposedBy: 'memory-run-1',
      createdAt: 'now',
      scenario: {
        id: 'koala-checks-tasks-before-planning',
        name: GOOD.name,
        describe: GOOD.checks,
        agent: 'koala',
        procedure: { id: 'interactive-chat' },
        input: { message: GOOD.message },
        expect: { toolsCalled: ['list_tasks'] },
      },
    }]);
  });

  it('says exactly what is wrong with a test it cannot run, and queues nothing', async () => {
    const out = await propose({ ...GOOD, toolsCalled: ['summon_unicorn'] });
    expect(out).toMatchObject({ ok: false, content: 'not proposed: it expects summon_unicorn, which is not a tool' });
    expect((await propose({ ...GOOD, agent: 'nobody' })).content).toBe('there is no agent called "nobody"');
    expect((await propose({ ...GOOD, toolsCalled: [] })).content).toContain('the scenario has to expect something');
    expect(saved).toEqual([]);
  });

  it('does not queue a test the person already has, or one already waiting', async () => {
    existing = ['koala-checks-tasks-before-planning'];
    expect((await propose(GOOD)).ok).toBe(false);

    existing = [];
    await propose(GOOD);
    expect((await propose(GOOD)).content).toBe('koala-checks-tasks-before-planning is already waiting for the person; nothing was proposed');
    expect(saved).toHaveLength(1);
  });

  it('is declared as a proposal, so it changes nothing the person relies on', () => {
    expect(SCENARIO_TOOLS.map((tool) => [tool.name, tool.effect])).toEqual([['propose_scenario', 'propose']]);
  });
});
