import { describe, it, expect } from 'vitest';
import {
  ALL_SEEDED_AGENTS,
  seededAgentSlugs,
  definedToolNames,
  STANDARD_HOST_TOOL_NAMES,
} from './seeds.js';
import { BUILDER_TOOLS } from '../tools/builder-tools-catalogue.js';
import { BUILT_IN_PROCEDURES } from '../procedure/seeds/procedures.js';
import { contractsFor, type ToolDefinition } from '../tools/catalogue.js';
import { capabilitiesFor, environmentFor, resolveAgent } from './agent.js';
import { resolveToolSet } from '../runtime/context.js';
import { effectiveTools } from '@koala/engine-core';

describe('seeded agents', () => {
  it('are all seeded rather than owned by anyone', () => {
    for (const agent of ALL_SEEDED_AGENTS()) expect(agent.ownerId).toBeUndefined();
  });

  it('each names a procedure that ships with them', () => {
    const procedures = new Set(BUILT_IN_PROCEDURES.map((procedure) => procedure.id));
    for (const persona of ALL_SEEDED_AGENTS()) {
      expect(procedures.has(persona.procedure), `${persona.slug} names ${persona.procedure}`).toBe(true);
    }
  });

  it('each only grants tools that exist', () => {
    const tools = definedToolNames();
    for (const agent of ALL_SEEDED_AGENTS()) {
      for (const tool of agent.tools) {
        expect(tools.has(tool), `${agent.slug} grants ${tool}, which is not defined`).toBe(true);
      }
    }
  });

  it('grants a persona only tools the catalogue declares', () => {
    const declared = definedToolNames();
    for (const persona of ALL_SEEDED_AGENTS()) {
      for (const tool of persona.tools) {
        expect(declared.has(tool), `${persona.slug} is granted ${tool}`).toBe(true);
      }
    }
  });

  it('each only delegates to agents that exist', () => {
    const slugs = seededAgentSlugs();
    for (const agent of ALL_SEEDED_AGENTS()) {
      for (const callee of agent.agents ?? []) expect(slugs.has(callee)).toBe(true);
    }
  });

  it('replaces the four old engines, plus interactive chat and a delivery loop', () => {
    expect(ALL_SEEDED_AGENTS().map((agent) => agent.slug).sort())
      .toEqual(['agent-builder', 'delivery', 'executor', 'grove-runner', 'judge', 'koala', 'leaf-executor', 'leaf-judge', 'planner', 'research']);
  });

  it('resolves by slug for any user with no forks present', () => {
    expect(resolveAgent(ALL_SEEDED_AGENTS(), 'user-1', 'research')?.name).toBe('Research');
  });
});

describe('seeded agents get environments that match what they do', () => {
  const agentBySlug = (slug: string) => ALL_SEEDED_AGENTS().find((agent) => agent.slug === slug)!;

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

  it('gives koala and the planner no machine at all', () => {
    for (const slug of ['koala', 'planner']) {
      expect(capabilitiesFor(agentBySlug(slug))).toMatchObject({ terminal: false, filesystem: false });
    }
  });

  it('gives the judge a machine, because it checks the work where the work was done', () => {
    expect(capabilitiesFor(agentBySlug('judge'))).toMatchObject({ terminal: true, filesystem: true });
  });
});

describe('seeded agents compose usable prompts', () => {
  const agentBySlug = (slug: string) => ALL_SEEDED_AGENTS().find((agent) => agent.slug === slug)!;
  const standardTools: ToolDefinition[] = STANDARD_HOST_TOOL_NAMES.map((name) => ({
    name,
    summary: name,
    binding: (name.includes('web') ? 'network' : name.includes('task') ? 'platform' : 'environment') as ToolDefinition['binding'],
    effect: 'read',
    parameters: { type: 'object', properties: {} },
    returns: 'string',
    failures: [],
    status: 'approved',
    ...(name === 'run_command' ? { requires: { terminal: true } } : {}),
    ...(name === 'read_file' || name === 'write_file' || name === 'list_dir' ? { requires: { filesystem: true } } : {}),
  }));
  const catalogue = contractsFor([...BUILDER_TOOLS, ...standardTools], ['draft', 'approved']);

  const offered = (slug: string, over: { tools?: string[]; agents?: string[] } = {}) => {
    const agent = { ...agentBySlug(slug), ...over };
    return resolveToolSet({
      agent,
      catalogue,
      capabilities: capabilitiesFor(agent),
      callable: ALL_SEEDED_AGENTS().filter((candidate) => (agent.agents ?? []).includes(candidate.slug)),
    });
  };

  it('offers the builder its four tools and withholds nothing', () => {
    const { tools, withheld } = offered('agent-builder');

    expect(tools.map((tool) => tool.name))
      .toEqual(['list_references', 'read_procedure', 'check_procedure', 'save_procedure']);
    expect(withheld).toEqual([]);
  });

  it('puts the procedure format, every node kind and a valid example in the builder\'s own prompt', () => {
    const { prompt } = agentBySlug('agent-builder');

    expect(prompt).toContain('PROCEDURE FORMAT');
    expect(prompt).toContain('- call-model (step)');
    expect(prompt).toContain('"schema": 2');
    expect(prompt).not.toContain('"initialStep"');
  });

  it('offers research the network tools it is granted, and withholds nothing', () => {
    const { tools, withheld } = offered('research');

    expect(tools.map((tool) => tool.name)).toEqual(['search_web', 'fetch_web_page']);
    expect(withheld).toEqual([]);
  });

  it('offers a persona with nothing granted nothing at all', () => {
    const { tools } = offered('planner', { tools: [], agents: [] });

    expect(tools).toEqual([]);
  });

  it('offers the judge what it needs to check work for itself, and not the hand that settles a leaf', () => {
    const { tools } = offered('judge');

    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_dir', 'read_file', 'run_command']);
  });

  it('gives the settling hand to the leaf-judge alone, alongside what it needs to check the claimed commit', () => {
    const { tools } = offered('leaf-judge');

    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_dir', 'read_file', 'run_command', 'settle_leaf']);
    expect(ALL_SEEDED_AGENTS().filter((agent) => agent.tools.includes('settle_leaf')).map((agent) => agent.slug)).toEqual(['leaf-judge']);
  });

  it('still offers koala its delegates, which come from agents rather than tools', () => {
    const { tools } = offered('koala');

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['planner', 'research']));
  });

  it('gives the leaf executor the claim and its executor delegate, but not settle_leaf', () => {
    const { tools } = offered('leaf-executor');
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(['claim_leaf', 'list_tasks', 'read_file', 'run_command', 'executor']));
    expect(names).not.toContain('settle_leaf');
  });
});
