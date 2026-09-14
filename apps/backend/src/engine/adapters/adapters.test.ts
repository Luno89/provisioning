import { describe, it, expect, vi } from 'vitest';
import { createAgentRegistry } from './registry.js';
import { createEndpointResolver, UnknownAgentError } from './endpoints.js';
import { SEEDED_AGENTS, SEEDED_LOOPS } from '../seeds.js';
import type { AgentDefinition } from '../agent.js';
import type { LoopGraph } from '../graph.js';
import type { ModelProvider } from '../../lib/model-registry.js';

const provider = (over: Partial<ModelProvider> = {}): ModelProvider => ({
  id: 'endpoint-1',
  name: 'Local vLLM',
  source: 'endpoint',
  model: 'qwen-72b',
  contextTokens: 32_000,
  ...over,
} as ModelProvider);

describe('agent registry', () => {
  it('resolves a seeded agent and the loop it points at', async () => {
    const registry = createAgentRegistry();
    const runnable = await registry.runnable('user-1', 'research');

    expect(runnable?.agent.slug).toBe('research');
    expect(runnable?.graph.id).toBe('research');
    expect(runnable?.graph.budget?.maxRounds).toBe(3);
  });

  it('resolves each seeded agent to a runnable loop', async () => {
    const registry = createAgentRegistry();
    for (const agent of SEEDED_AGENTS) {
      expect((await registry.runnable('user-1', agent.slug))?.graph.id).toBe(agent.loop);
    }
  });

  it('returns nothing for an agent nobody has defined', async () => {
    expect(await createAgentRegistry().runnable('user-1', 'ghost')).toBeUndefined();
  });

  it("prefers a user's own fork of an agent", async () => {
    const koala = SEEDED_AGENTS.find((a) => a.slug === 'koala')!;
    const fork: AgentDefinition = { ...koala, ownerId: 'user-1', name: 'My Koala' };
    const registry = createAgentRegistry({
      agentStore: { list: async () => [...SEEDED_AGENTS, fork] },
    });

    expect((await registry.agent('user-1', 'koala'))?.name).toBe('My Koala');
    expect((await registry.agent('user-2', 'koala'))?.name).toBe('Koala');
  });

  it("prefers a user's own fork of a loop, so forking research changes every caller", async () => {
    const forked = { ...SEEDED_LOOPS.find((l) => l.id === 'research')!, ownerId: 'user-1', budget: { maxRounds: 9 } } as LoopGraph;
    const registry = createAgentRegistry({
      loopStore: { list: async () => [...SEEDED_LOOPS, forked] },
    });

    expect((await registry.runnable('user-1', 'research'))?.graph.budget?.maxRounds).toBe(9);
    expect((await registry.runnable('user-2', 'research'))?.graph.budget?.maxRounds).toBe(3);
  });

  it('returns nothing runnable when the loop an agent names is missing', async () => {
    const orphan: AgentDefinition = { ...SEEDED_AGENTS.find((a) => a.slug === 'koala')!, slug: 'orphan', loop: 'no-such-loop' };
    const registry = createAgentRegistry({ agentStore: { list: async () => [orphan] } });

    expect(await registry.runnable('user-1', 'orphan')).toBeUndefined();
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
    const koala = SEEDED_AGENTS.find((a) => a.slug === 'koala')!;
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
