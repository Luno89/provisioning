import { describe, it, expect, vi } from 'vitest';
import { createAgentRegistry, createStoredAgentRegistry } from './registry.js';
import { createEndpointResolver, UnknownAgentError } from './endpoints.js';
import {
  type AgentDefinition,
  type ModelProvider,
  type ProcedureSource,
} from '@koala/agent-engine';
import { RESEARCH_V2, defineGroup, type Procedure } from '@koala/agent-engine/procedure';
import { seededPersonas } from '../../extensions/seeds.js';
import { ENGINE_TOOL_SEEDS } from '../../lib/engine-tool-seeds.js';

const provider = (over: Partial<ModelProvider> = {}): ModelProvider => ({
  id: 'endpoint-1',
  name: 'Local vLLM',
  source: 'endpoint',
  model: 'qwen-72b',
  contextTokens: 32_000,
  ...over,
} as ModelProvider);

const stored = (over: Partial<ProcedureSource> & { procedure: object }): ProcedureSource => ({
  id: 'research',
  version: '1',
  updatedAt: '2026-09-16T00:00:00.000Z',
  source: JSON.stringify(over.procedure),
  ...over,
});

describe('agent registry', () => {
  it('resolves a seeded agent and the procedure it points at', async () => {
    const runnable = await createAgentRegistry().runnable('user-1', 'research');

    expect(runnable?.agent.slug).toBe('research');
    expect(runnable?.procedure).toEqual(RESEARCH_V2);
  });

  it('resolves every seeded agent to a procedure it can run', async () => {
    const registry = createAgentRegistry();
    for (const agent of seededPersonas()) {
      expect((await registry.runnable('user-1', agent.slug))?.procedure.id, agent.slug).toBe(agent.procedure);
    }
  });

  it('returns nothing for an agent nobody has defined', async () => {
    expect(await createAgentRegistry().runnable('user-1', 'ghost')).toBeUndefined();
  });

  it("prefers a user's own fork of an agent", async () => {
    const koala = seededPersonas().find((a) => a.slug === 'koala')!;
    const fork: AgentDefinition = { ...koala, ownerId: 'user-1', name: 'My Koala' };
    const registry = createAgentRegistry({
      agentStore: { list: async () => [...seededPersonas(), fork] },
    });

    expect((await registry.agent('user-1', 'koala'))?.name).toBe('My Koala');
    expect((await registry.agent('user-2', 'koala'))?.name).toBe('Koala');
  });

  it('lists each built-in agent once, even when an old copy of it is still stored without an owner', async () => {
    const leftover = { ...seededPersonas().find((agent) => agent.slug === 'koala')!, name: 'Stale Koala' };
    const mine = { ...leftover, ownerId: 'user-1', name: 'My Koala' };
    const registry = createStoredAgentRegistry({
      personas: { list: async () => [leftover, mine] },
      procedures: { list: async () => [] },
    });

    const slugs = (await registry.agents('user-1')).map((agent) => agent.slug);
    expect(slugs.filter((slug) => slug === 'koala')).toHaveLength(1);
    expect(slugs).toHaveLength(new Set(slugs).size);
    expect((await registry.agent('user-1', 'koala'))?.name).toBe('My Koala');
    expect((await registry.agent('user-2', 'koala'))?.name).toBe('Koala');
  });

  it('hides the agents and tools of an extension an owner switched off, from that owner alone', async () => {
    const hidden = { extensions: new Set(['grove']), operations: new Set<string>(), groups: new Set<string>(), tools: new Set(['claim_leaf']), agents: new Set(['grove', 'grove-leaf']) };
    const registry = createStoredAgentRegistry({
      personas: { list: async () => [] },
      procedures: { list: async () => [] },
      tools: { list: async () => [...ENGINE_TOOL_SEEDS] },
      hidden: async (ownerId) => (ownerId === 'user-1' ? hidden : { ...hidden, extensions: new Set(), tools: new Set(), agents: new Set() }),
    });

    const mine = (await registry.agents('user-1')).map((agent) => agent.slug);
    expect(mine).not.toContain('grove');
    expect(mine).toContain('koala');
    expect((await registry.agents('user-2')).map((agent) => agent.slug)).toContain('grove');
    expect((await registry.tools('user-1')).map((tool) => tool.name)).not.toContain('claim_leaf');
    expect((await registry.tools('user-2')).map((tool) => tool.name)).toContain('claim_leaf');
  });

  it('hands a run the published groups its procedure uses, copied in so the workflow never has to look them up', async () => {
    const shout = (id: string) => defineGroup(id, {
      title: 'Shout', describe: 'Passes the text on.',
      inputs: { text: { type: 'text', describe: 'What to say.', required: true } },
      outputs: {},
      exits: { done: { describe: 'It was said.' }, quiet: { describe: 'Nothing was said.' } },
    }, (g) => {
      const echo = g.condition('echo', { value: g.inputs.text }, { expression: 'true' });
      g.start(echo);
      echo.on('true', g.exits.done);
      echo.on('false', g.exits.quiet);
      g.layout({ echo: [0, 0] });
    });
    const published = shout('loud.shout@2');
    const other = shout('loud.whisper@1');
    const procedure: Procedure = {
      ...RESEARCH_V2,
      nodes: [...RESEARCH_V2.nodes, { id: 'hello', kind: 'text', settings: { text: 'hi' }, position: { x: 0, y: 0 } }, { id: 'shout', kind: 'group', group: 'loud.shout@2', settings: {}, position: { x: 0, y: 0 } }],
      wires: [...RESEARCH_V2.wires, { from: { node: 'hello', socket: 'text' }, to: { node: 'shout', socket: 'text' } }],
      flow: [...RESEARCH_V2.flow, { from: 'shout', exit: 'done', to: RESEARCH_V2.start }, { from: 'shout', exit: 'quiet', to: RESEARCH_V2.start }],
      start: 'shout',
    };
    const usesIt = stored({ ownerId: 'user-1', procedure });
    const registry = createStoredAgentRegistry({
      personas: { list: async () => [] },
      procedures: { list: async () => [usesIt] },
      published: async (ownerId) => (ownerId === 'user-1' ? [published, other] : []),
    });

    const runnable = await registry.runnable('user-1', 'research');
    expect(runnable?.procedure.groups.map((group) => group.id)).toEqual(['loud.shout@2']);

    const off = { extensions: new Set(['loud']), operations: new Set<string>(), groups: new Set(['loud.shout@2', 'loud.whisper@1']), tools: new Set<string>(), agents: new Set<string>() };
    const switchedOff = createStoredAgentRegistry({
      personas: { list: async () => [] },
      procedures: { list: async () => [usesIt] },
      published: async () => [published, other],
      hidden: async (ownerId) => (ownerId === 'user-1' ? off : { ...off, groups: new Set<string>() }),
    });
    await expect(switchedOff.runnable('user-1', 'research')).rejects.toThrow(/research cannot run: "shout" uses the group loud.shout@2, from an extension that is switched off/);
  });

  it("serves a user's own copy of a procedure to that user only", async () => {
    const copy = stored({ ownerId: 'user-1', procedure: { ...RESEARCH_V2, budget: { maxRounds: 9 } } });
    const registry = createStoredAgentRegistry({
      personas: { list: async () => [] },
      procedures: { list: async () => [copy] },
    });

    expect((await registry.runnable('user-1', 'research'))?.procedure.budget.maxRounds).toBe(9);
    expect((await registry.runnable('user-2', 'research'))?.procedure.budget).toEqual({});
  });

  it('ignores a stored procedure it cannot read, and says why', async () => {
    const old = stored({ ownerId: 'user-1', procedure: { id: 'research', version: '1', initialStep: 'ask', nodes: [] } });
    const broken = stored({ id: 'half', ownerId: 'user-1', procedure: { ...RESEARCH_V2, id: 'half', flow: [] } });
    const registry = createStoredAgentRegistry({
      personas: { list: async () => [] },
      procedures: { list: async () => [old, broken] },
    });

    expect((await registry.runnable('user-1', 'research'))?.procedure).toEqual(RESEARCH_V2);
    expect(await registry.procedure('user-1', 'half')).toBeUndefined();
  });

  it('runs any persona against any procedure the caller names', async () => {
    const registry = createAgentRegistry();

    const own = await registry.runnable('user-1', 'koala');
    const borrowed = await registry.runnable('user-1', 'koala', 'single-shot');

    expect(own?.procedure.id).toBe('interactive-chat');
    expect(borrowed?.procedure.id).toBe('single-shot');
    expect(borrowed?.agent.slug).toBe('koala');
  });

  it('hands every run its own copy of the procedure, so editing one changes nothing else', async () => {
    const registry = createAgentRegistry();

    const first = await registry.runnable('user-1', 'koala');
    first!.procedure.budget = { maxRounds: 1 };
    const second = await registry.runnable('user-1', 'koala');

    expect(second?.procedure.budget).toEqual({});
  });

  it('lists only the agents an agent is allowed to call', async () => {
    const registry = createAgentRegistry();
    const callable = await registry.callable('user-1', 'koala');

    expect(callable.map((a) => a.slug).sort()).toEqual(['planner', 'research']);
    expect(await registry.callable('user-1', 'judge')).toEqual([]);
  });
});

describe('endpoint resolver', () => {
  const models = (over: Partial<ModelProvider> = {}) => ({
    resolveBaseUrl: vi.fn(async () => ({
      provider: provider(over),
      baseUrl: 'https://models.test/v1',
      apiKey: 'secret',
    })),
  });

  it('builds an endpoint for an agent, always with a rate-limit key', async () => {
    const service = models();
    const resolver = createEndpointResolver({ models: service, registry: createAgentRegistry() });

    const resolved = await resolver.forAgent({ ownerId: 'user-1', agentSlug: 'koala' });

    expect(resolved.endpoint).toMatchObject({
      baseUrl: 'https://models.test/v1',
      apiKey: 'secret',
      model: 'qwen-72b',
      rateLimitKey: 'endpoint-1',
      ownerId: 'user-1',
      label: 'Local vLLM',
    });
  });

  it('keeps a rate-limit key even for a deployment rather than a registered endpoint', async () => {
    const service = models({ source: 'deployment' as ModelProvider['source'], id: 'vllm-app-7' });
    const resolver = createEndpointResolver({ models: service, registry: createAgentRegistry() });

    const resolved = await resolver.forAgent({ ownerId: 'user-1', agentSlug: 'koala' });

    expect(resolved.endpoint.rateLimitKey).toBe('vllm-app-7');
  });

  it("routes through the agent's own endpoint binding when it has one", async () => {
    const koala = seededPersonas().find((a) => a.slug === 'koala')!;
    const pinned: AgentDefinition = { ...koala, model: { endpointId: 'endpoint-9' } };
    const service = models();
    const resolver = createEndpointResolver({
      models: service,
      registry: createAgentRegistry({ agentStore: { list: async () => [pinned] } }),
    });

    await resolver.forAgent({ ownerId: 'user-1', agentSlug: 'koala' });

    expect(service.resolveBaseUrl).toHaveBeenCalledWith('user-1', undefined, 'endpoint-9');
  });

  it('fits the reply budget to what is left of the context window', async () => {
    const service = models({ contextTokens: 8_000 });
    const resolver = createEndpointResolver({ models: service, registry: createAgentRegistry() });

    const roomy = await resolver.forAgent({ ownerId: 'user-1', agentSlug: 'koala', promptChars: 0 });
    const cramped = await resolver.forAgent({ ownerId: 'user-1', agentSlug: 'koala', promptChars: 28_000 });

    expect(roomy.maxTokens).toBeGreaterThan(cramped.maxTokens);
    expect(cramped.maxTokens).toBeGreaterThanOrEqual(512);
  });

  it('says which agent is missing rather than failing obscurely', async () => {
    const resolver = createEndpointResolver({ models: models(), registry: createAgentRegistry() });

    await expect(resolver.forAgent({ ownerId: 'user-1', agentSlug: 'ghost' }))
      .rejects.toThrow(UnknownAgentError);
  });
});
