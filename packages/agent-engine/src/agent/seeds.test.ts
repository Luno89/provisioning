import { describe, it, expect } from 'vitest';
import {
  ALL_SEEDED_AGENTS,
  seededAgentSlugs,
  definedToolNames,
} from './seeds.js';
import { BUILDER_TOOLS } from '../tools/builder-tools-catalogue.js';
import { BUILT_IN_PROCEDURES } from '../procedure/seeds/procedures.js';
import { contractsFor } from '../tools/catalogue.js';
import { capabilitiesFor, resolveAgent } from './agent.js';
import { resolveToolSet } from '../runtime/context.js';

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

  it('are the engine\'s own builder and nothing of any product built on it', () => {
    expect(ALL_SEEDED_AGENTS().map((agent) => agent.slug)).toEqual(['agent-builder']);
  });

  it('resolves by slug for any user with no forks present', () => {
    expect(resolveAgent(ALL_SEEDED_AGENTS(), 'user-1', 'agent-builder')?.name).toBe('Agent builder');
  });

  it('name no product: the engine\'s seeds carry no grove, leaf, tree or koala', () => {
    const seeded = JSON.stringify({ agents: ALL_SEEDED_AGENTS(), procedures: BUILT_IN_PROCEDURES });
    expect(seeded).not.toMatch(/grove|\bleaf|koala|propose_plan|read_tree/i);
  });
});

describe('the builder composes a usable prompt', () => {
  const builder = ALL_SEEDED_AGENTS().find((agent) => agent.slug === 'agent-builder')!;
  const agentBySlug = (_slug: string) => builder;
  const catalogue = contractsFor([...BUILDER_TOOLS]);
  const offered = (slug: string) => {
    const agent = agentBySlug(slug);
    return resolveToolSet({ agent, catalogue, capabilities: capabilitiesFor(agent), callable: [] });
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

});
