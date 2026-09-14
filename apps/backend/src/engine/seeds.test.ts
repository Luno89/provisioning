import { describe, it, expect } from 'vitest';
import {
  SEEDED_AGENTS,
  SEEDED_LOOPS,
  seededAgentSlugs,
  seededLoopIds,
  definedToolNames,
  loopsPendingTools,
} from './seeds.js';
import { BUILDER_TOOLS } from './builder-tools-catalogue.js';
import { contractsFor } from './catalogue.js';
import { graphErrors, validateGraph } from './graph.js';
import { capabilitiesFor, environmentFor, resolveAgent } from './agent.js';
import { composeContext } from './context.js';
import { effectiveTools } from '@koala/engine-core';

describe('seeded loops', () => {
  const pending = new Set(loopsPendingTools().map((entry) => entry.loop));

  it.each(SEEDED_LOOPS.filter((loop) => !pending.has(loop.id)).map((loop) => [loop.id, loop] as const))(
    '%s validates cleanly',
    (_id, loop) => {
      const problems = validateGraph(loop, { agents: seededAgentSlugs(), tools: definedToolNames() });
      expect(graphErrors(problems)).toEqual([]);
    },
  );

  it('names exactly the loops still waiting on tools that do not exist', () => {
    expect(loopsPendingTools()).toEqual([
      { loop: 'delivery', missing: ['list_tasks'] },
      { loop: 'do-one-task', missing: ['start_task', 'run_command', 'mark_done'] },
    ]);
  });

  it('fails those loops loudly rather than letting them look runnable', () => {
    for (const { loop: id, missing } of loopsPendingTools()) {
      const loop = SEEDED_LOOPS.find((candidate) => candidate.id === id)!;
      const problems = graphErrors(
        validateGraph(loop, { agents: seededAgentSlugs(), tools: definedToolNames() }),
      ).map((problem) => problem.message).join(' ');

      for (const tool of missing) expect(problems).toContain(tool);
    }
  });

  it('gives every loop that can cycle a budget', () => {
    for (const loop of SEEDED_LOOPS) {
      expect(loop.budget).toBeDefined();
      expect(loop.budget?.maxRounds).toBeGreaterThan(0);
    }
  });

  it('bounds research much more tightly than open-ended work', () => {
    const research = SEEDED_LOOPS.find((loop) => loop.id === 'research');
    const work = SEEDED_LOOPS.find((loop) => loop.id === 'tool-rounds');
    expect(research?.budget?.maxRounds).toBe(3);
    expect(work?.budget?.maxRounds).toBeGreaterThan(research!.budget!.maxRounds!);
  });

  it('routes every loop that offers tools through a dispatch node', () => {
    for (const loop of SEEDED_LOOPS) {
      const offersTools = loop.nodes.some((node) => node.kind === 'model' && node.tools === 'granted');
      const dispatches = loop.nodes.some((node) => node.kind === 'dispatch');
      expect(offersTools).toBe(dispatches);
    }
  });

  it('gives the judge loop exactly one model call with no tools', () => {
    const judge = SEEDED_LOOPS.find((loop) => loop.id === 'single-shot');
    const models = judge?.nodes.filter((node) => node.kind === 'model') ?? [];
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ tools: 'none' });
    expect(judge?.budget?.maxRounds).toBe(1);
  });
});

describe('seeded agents', () => {
  it('are all seeded rather than owned by anyone', () => {
    for (const agent of SEEDED_AGENTS) expect(agent.ownerId).toBeUndefined();
  });

  it('each points at a loop that ships with them', () => {
    const loops = seededLoopIds();
    for (const agent of SEEDED_AGENTS) expect(loops.has(agent.loop)).toBe(true);
  });

  it('each only grants tools that exist', () => {
    const tools = definedToolNames();
    for (const agent of SEEDED_AGENTS) {
      for (const tool of agent.tools) {
        expect(tools.has(tool), `${agent.slug} grants ${tool}, which is not defined`).toBe(true);
      }
    }
  });

  it('leaves every agent but the builder with no tools, because theirs are not defined yet', () => {
    const withTools = SEEDED_AGENTS.filter((agent) => agent.tools.length > 0);
    expect(withTools.map((agent) => agent.slug)).toEqual(['agent-builder']);
  });

  it('each only delegates to agents that exist', () => {
    const slugs = seededAgentSlugs();
    for (const agent of SEEDED_AGENTS) {
      for (const callee of agent.agents ?? []) expect(slugs.has(callee)).toBe(true);
    }
  });

  it('replaces the four old engines, plus interactive chat and a delivery loop', () => {
    expect(SEEDED_AGENTS.map((agent) => agent.slug).sort())
      .toEqual(['agent-builder', 'delivery', 'executor', 'judge', 'koala', 'planner', 'research']);
  });

  it('resolves by slug for any user with no forks present', () => {
    expect(resolveAgent(SEEDED_AGENTS, 'user-1', 'research')?.name).toBe('Research');
  });
});

describe('seeded agents get environments that match what they do', () => {
  const agentBySlug = (slug: string) => SEEDED_AGENTS.find((agent) => agent.slug === slug)!;

  it('gives research the network and nothing else', () => {
    const caps = capabilitiesFor(agentBySlug('research'));
    expect(caps).toMatchObject({ egress: true, terminal: false, filesystem: false });
  });

  it('gives the executor a machine and pins it to a workspace', () => {
    const executor = agentBySlug('executor');
    expect(capabilitiesFor(executor)).toMatchObject({ terminal: true, filesystem: true });
    expect(executor.interface?.workspace).toBe(true);
    expect(environmentFor(executor).kind).toBe('sandbox');
  });

  it('gives koala, the planner and the judge no machine at all', () => {
    for (const slug of ['koala', 'planner', 'judge']) {
      expect(capabilitiesFor(agentBySlug(slug))).toMatchObject({ terminal: false, filesystem: false });
    }
  });
});

describe('seeded agents compose usable prompts', () => {
  const agentBySlug = (slug: string) => SEEDED_AGENTS.find((agent) => agent.slug === slug)!;
  const catalogue = contractsFor(BUILDER_TOOLS, ['draft', 'approved']);

  it('offers the builder its three tools and withholds nothing', () => {
    const builder = agentBySlug('agent-builder');
    const composed = composeContext({
      agent: builder,
      environment: { kind: 'none', egress: false },
      capabilities: capabilitiesFor(builder),
      catalogue,
    });

    expect(composed.tools.map((tool) => tool.name)).toEqual(['read_agent', 'compile_agent', 'write_agent']);
    expect(composed.withheld).toEqual([]);
  });

  it('puts the loop grammar in front of the builder, since no model has seen this syntax', () => {
    const builder = agentBySlug('agent-builder');
    const composed = composeContext({
      agent: builder,
      environment: { kind: 'none', egress: false },
      capabilities: capabilitiesFor(builder),
      catalogue,
    });

    expect(composed.text).toContain('THE LOOP SYNTAX');
    expect(composed.text).toContain('terminal <outcome>');
  });

  it('offers an agent with no tools none, and does not pretend otherwise', () => {
    const research = agentBySlug('research');
    const composed = composeContext({
      agent: research,
      environment: { kind: 'none', egress: true },
      capabilities: capabilitiesFor(research),
      catalogue,
    });

    expect(composed.tools).toEqual([]);
    expect(composed.withheld).toEqual([]);
    expect(composed.text).not.toContain('TOOLS YOU CAN USE RIGHT NOW');
  });

  it('still offers koala its delegates, which come from agents rather than tools', () => {
    const koala = agentBySlug('koala');
    const composed = composeContext({
      agent: koala,
      environment: { kind: 'none', egress: true },
      capabilities: capabilitiesFor(koala),
      catalogue,
      callable: SEEDED_AGENTS.filter((agent) => (koala.agents ?? []).includes(agent.slug)),
    });

    expect(composed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['planner', 'research']),
    );
  });
});
