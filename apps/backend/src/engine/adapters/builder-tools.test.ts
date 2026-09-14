import { describe, it, expect, vi } from 'vitest';
import { createBuilderTools, type AgentSource, type BuilderScope } from './builder-tools.js';
import type { AgentDefinition } from '../agent.js';
import type { ToolDefinition } from '../catalogue.js';
import type { ImageBuilder } from './image-builder.js';
import type { LoopGraph } from '../graph.js';
import type { ToolHandlerContext } from '@koala/engine-core';

const ROUNDS: LoopGraph = {
  id: 'tool-rounds',
  version: '1',
  entry: 'think',
  budget: { maxRounds: 6 },
  nodes: [
    { kind: 'model', id: 'think', tools: 'granted', next: [{ to: 'work', when: 'not empty(reply.toolCalls)' }, { to: 'done' }] },
    { kind: 'dispatch', id: 'work', next: [{ to: 'think' }] },
    { kind: 'terminal', id: 'done', outcome: 'ok' },
  ],
};

const EXISTING: AgentDefinition = {
  slug: 'researcher',
  name: 'Researcher',
  description: 'Answers questions from the web',
  version: '1',
  prompt: 'You answer questions.\nCite what you used.',
  loop: 'tool-rounds',
  tools: ['search_web'],
  budget: { maxRounds: 6 },
  environment: { egress: true },
  interface: { outputs: ['findings'] },
};

const definition = (name: string, over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  summary: `the ${name} tool`,
  binding: 'platform',
  effect: 'read',
  status: 'approved',
  approvedBy: 'luno',
  returns: 'something',
  failures: [{ when: 'it is called wrongly', says: 'that was wrong' }],
  parameters: { type: 'object', properties: { x: { type: 'string', description: 'x' } } },
  ...over,
});

const CATALOGUE: ToolDefinition[] = [
  definition('search_web', { binding: 'network' }),
  definition('fetch_web_page', { binding: 'network' }),
  definition('propose_work', { effect: 'propose' }),
  definition('run_command', { binding: 'environment', effect: 'write' }),
  definition('deploy_app', { effect: 'write' }),
];

function harness(over: Partial<BuilderScope> & { images?: Partial<ImageBuilder> } = {}) {
  const saved: AgentSource[] = [];

  const store = {
    get: vi.fn(async (_owner: string, slug: string) => saved.find((entry) => entry.slug === slug)),
    save: vi.fn(async (entry: AgentSource) => { saved.push(entry); }),
  };

  const tools = createBuilderTools({
    store,
    images: { ensure: async (plan) => plan.base, exists: async () => true, ...(over.images ?? {}) },
    now: () => '2026-01-01T00:00:00.000Z',
    scope: {
      agents: async () => [EXISTING],
      loops: async () => [ROUNDS],
      catalogue: async () => CATALOGUE,
      granted: async () => ['search_web', 'fetch_web_page', 'propose_work'],
      ...over,
    },
  });

  const call = (name: string, args: Record<string, unknown>, caller: { ownerId?: string } = { ownerId: 'user-1' }) =>
    tools[name]!({ name, parsed: args, driver: undefined, caller } as ToolHandlerContext);

  return { call, saved, store };
}

describe('read_agent', () => {
  it('hands back a built-in as text the model can edit', async () => {
    const { call } = harness();
    const out = await call('read_agent', { agent: 'researcher' });

    expect(out.ok).toBe(true);
    expect(out.content).toContain('agent researcher v1');
    expect(out.content).toContain('tools search_web');
    expect(out.content).toContain('loop tool-rounds');
  });

  it('includes the loop the agent runs, so the whole thing can be edited at once', async () => {
    const { call } = harness();
    const out = await call('read_agent', { agent: 'researcher' });

    expect(out.content).toContain('loop tool-rounds v1');
    expect(out.content).toContain('think: model');
  });

  it('hands back your own copy once you have one, not the built-in', async () => {
    const { call } = harness();
    await call('write_agent', { source: 'agent researcher v2\n  loop tool-rounds\n  tools search_web\n' });

    const out = await call('read_agent', { agent: 'researcher' });
    expect(out.content).toContain('v2');
  });

  it('says so when there is no such agent', async () => {
    const { call } = harness();
    const out = await call('read_agent', { agent: 'ghost' });

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('no agent called "ghost"');
  });

  it('asks for the argument it needs rather than guessing', async () => {
    expect((await harness().call('read_agent', {})).digest).toContain('needs an "agent"');
  });
});

describe('compile_agent', () => {
  it('confirms what it would define when the source is good', async () => {
    const { call } = harness();
    const out = await call('compile_agent', {
      source: 'agent helper v1\n  loop tool-rounds\n  tools search_web\n',
    });

    expect(out.ok).toBe(true);
    expect(out.digest).toContain('agent helper');
  });

  it('returns errors with line numbers, which is the whole point', async () => {
    const { call } = harness();
    const out = await call('compile_agent', {
      source: 'agent helper v1\n  loop ghost-loop\n  tools not_a_tool\n',
    });

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('line 1');
    expect(out.digest).toContain('runs loop "ghost-loop"');
    expect(out.digest).toContain('is not a tool');
  });

  it('never saves anything', async () => {
    const { call, store } = harness();
    await call('compile_agent', { source: 'agent helper v1\n  loop tool-rounds\n' });

    expect(store.save).not.toHaveBeenCalled();
  });
});

describe('write_agent', () => {
  it('saves a compiling agent as the caller\'s own copy', async () => {
    const { call, saved } = harness();
    const out = await call('write_agent', {
      source: 'agent helper v1\n  loop tool-rounds\n  tools search_web\n',
    });

    expect(out.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ slug: 'helper', ownerId: 'user-1', version: '1' });
  });

  it('stores the text as written, because the text is the record', async () => {
    const source = 'agent helper v1\n  loop tool-rounds\n  tools search_web\n';
    const { call, saved } = harness();
    await call('write_agent', { source });

    expect(saved[0]?.source).toBe(source);
  });

  it('refuses to save something that does not compile, and says why', async () => {
    const { call, store } = harness();
    const out = await call('write_agent', { source: 'agent helper v1\n  loop ghost-loop\n' });

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('not saved');
    expect(out.digest).toContain('ghost-loop');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('will not let an agent grant a tool the caller does not have', async () => {
    const { call, store } = harness();
    const out = await call('write_agent', {
      source: 'agent helper v1\n  loop tool-rounds\n  tools run_command, deploy_app\n',
    });

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('cannot grant tools you do not have');
    expect(out.digest).toContain('deploy_app');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('allows exactly the tools the caller does have', async () => {
    const { call } = harness();
    const out = await call('write_agent', {
      source: 'agent helper v1\n  loop tool-rounds\n  tools search_web, fetch_web_page, propose_work\n',
    });

    expect(out.ok).toBe(true);
  });

  it('saves an agent and the loop it was written with together', async () => {
    const { call, saved } = harness();
    const out = await call('write_agent', {
      source: [
        'loop quick v1',
        '  entry done',
        '  done: terminal ok',
        '',
        'agent helper v1',
        '  loop quick',
      ].join('\n'),
    });

    expect(out.ok).toBe(true);
    expect(saved[0]?.source).toContain('loop quick v1');
  });

  it('refuses a source that defines no agent at all', async () => {
    const { call } = harness();
    const out = await call('write_agent', {
      source: 'loop quick v1\n  entry done\n  done: terminal ok\n',
    });

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('defines no agent');
  });

  it('refuses when the run has no owner to save for', async () => {
    const { call } = harness();
    const out = await call('write_agent', { source: 'agent a v1\n  loop tool-rounds\n' }, {});

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('no owner');
  });
});

describe('building the workspace at save time', () => {
  const needsPsql = definition('query_db', {
    binding: 'environment',
    needsBinaries: ['psql'],
    install: { via: 'dnf', packages: ['postgresql'] },
  });

  const source = [
    'agent digger v1',
    '  loop  tool-rounds',
    '  needs terminal, filesystem',
    '  tools query_db',
  ].join('\n');

  it('builds the image the new agent will need, before saving it', async () => {
    const built: string[] = [];
    const { call, saved } = harness({
      catalogue: async () => [...CATALOGUE, needsPsql],
      granted: async () => [...CATALOGUE.map((t) => t.name), 'query_db'],
      images: {
        ensure: async (plan) => { built.push(plan.fingerprint); return plan.base; },
      },
    });

    const out = await call('write_agent', { source });

    expect(out.ok).toBe(true);
    expect(built).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });

  it('refuses the save when that workspace will not build, and says why', async () => {
    const { call, store } = harness({
      catalogue: async () => [...CATALOGUE, needsPsql],
      granted: async () => [...CATALOGUE.map((t) => t.name), 'query_db'],
      images: {
        ensure: async () => { throw new Error('error building image: no such package'); },
      },
    });

    const out = await call('write_agent', { source });

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('digger needs a workspace that will not build');
    expect(out.digest).toContain('no such package');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('builds nothing for an agent that never gets a workspace', async () => {
    const built: string[] = [];
    const { call } = harness({
      images: { ensure: async (plan) => { built.push(plan.base); return plan.base; } },
    });

    const out = await call('write_agent', {
      source: 'agent thinker v1\n  loop tool-rounds\n  tools propose_work\n',
    });

    expect(out.ok).toBe(true);
    expect(built).toEqual([]);
  });

  it('refuses a tool needing a binary nothing installs, at save rather than mid-run', async () => {
    const unbuildable = definition('query_db', { binding: 'environment', needsBinaries: ['psql'] });

    const { call, store } = harness({
      catalogue: async () => [...CATALOGUE, unbuildable],
      granted: async () => [...CATALOGUE.map((t) => t.name), 'query_db'],
    });

    const out = await call('write_agent', { source });

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('query_db needs psql');
    expect(store.save).not.toHaveBeenCalled();
  });
});
