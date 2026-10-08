import { describe, it, expect } from 'vitest';
import { BUILDER_TOOLS, capabilitiesFor, contractsFor, environmentFor, resolveToolSet } from '@koala/agent-engine';
import { extensionTools, seededPersonas } from './seeds.js';

const ALL_SEEDED_AGENTS = seededPersonas;

describe('seeded agents get environments that match what they do', () => {
  const agentBySlug = (slug: string) => ALL_SEEDED_AGENTS().find((agent) => agent.slug === slug)!;

  it('gives research the network and files to write its findings in, but no shell', () => {
    const research = agentBySlug('research');
    expect(capabilitiesFor(research)).toMatchObject({ egress: true, filesystem: true });
    expect(environmentFor(research).kind).toBe('sandbox');
    expect(research.tools).not.toContain('run_command');
  });

  it('gives the paper writer the network and a workspace, because it writes down what it found', () => {
    const writer = agentBySlug('paper-writer');
    expect(capabilitiesFor(writer)).toMatchObject({ egress: true, filesystem: true });
    expect(environmentFor(writer).kind).toBe('sandbox');
    expect(writer.interface?.workspace).toBe(true);
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
  const catalogue = contractsFor([...BUILDER_TOOLS, ...extensionTools()]);

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

  it('offers research the web and corpus tools it is granted, and withholds nothing', () => {
    const { tools, withheld } = offered('research');

    expect(tools.map((tool) => tool.name)).toEqual(['search_web', 'fetch_web_page', 'search_corpus', 'read_file', 'write_file', 'list_dir']);
    expect(withheld).toEqual([]);
  });

  it('offers a persona with nothing granted nothing at all', () => {
    const { tools } = offered('planner', { tools: [], agents: [] });

    expect(tools).toEqual([]);
  });

  it('offers the judge what it needs to check work for itself and record its verdict, and not the hand that settles a leaf', () => {
    const { tools } = offered('judge');

    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_dir', 'read_file', 'record_verdict', 'run_command']);
    expect(agentBySlug('judge').prompt).toContain('Give your verdict with record_verdict');
  });

  it('tells the planner to write its own files only in a conversation\'s workspace', () => {
    expect(agentBySlug('planner').tools).toContain('write_file');
    expect(agentBySlug('planner').prompt).toMatch(/When your workspace belongs to the conversation[^]*Anywhere else, write no files/);
  });

  it('gives the settling hand to the leaf-judge alone, alongside what it needs to check the claimed commit and read the runs that did the work', () => {
    const { tools } = offered('leaf-judge');

    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_dir', 'read_file', 'read_run', 'run_command', 'settle_leaf']);
    expect(ALL_SEEDED_AGENTS().filter((agent) => agent.tools.includes('settle_leaf')).map((agent) => agent.slug)).toEqual(['leaf-judge']);
  });

  it('still offers koala its delegates, which come from agents rather than tools', () => {
    const { tools } = offered('koala');

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['planner', 'research']));
  });

  it('has no model at the leaf level: nothing seeded claims a leaf, and the grove agents only hand claims to the leaf-judge', () => {
    expect(ALL_SEEDED_AGENTS().filter((agent) => agent.tools.includes('claim_leaf')).map((agent) => agent.slug)).toEqual([]);
    for (const slug of ['grove', 'grove-paper']) expect(agentBySlug(slug).agents).toContain('leaf-judge');
    expect(agentBySlug('grove').tools).toEqual([]);
  });
});
