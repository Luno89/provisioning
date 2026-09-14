import { describe, it, expect, vi } from 'vitest';
import { createEngineActivities, type EngineServices } from './activities.js';
import { createEventBus, type EngineEvent } from '../events.js';
import { createAgentRegistry } from '../adapters/registry.js';
import type { ModelCallArgs, RunTicket } from './contracts.js';
import type { Monitor } from '../monitors.js';

const ticket = (over: Partial<RunTicket> = {}): RunTicket => ({
  runId: 'run-1',
  depth: 0,
  ownerId: 'user-1',
  agentSlug: 'koala',
  trigger: 'user',
  ...over,
});

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n`;

function streamingResponse(chunks: string[]) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => chunks.join(''),
    body: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  } as unknown as Response;
}

function services(over: Partial<EngineServices> = {}): { services: EngineServices; events: EngineEvent[] } {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));

  return {
    events,
    services: {
      registry: createAgentRegistry(),
      endpoints: {
        forAgent: vi.fn(async () => ({
          endpoint: {
            baseUrl: 'https://models.test/v1',
            apiKey: 'k',
            model: 'test-model',
            rateLimitKey: `bucket-${Math.random()}`,
            ownerId: 'user-1',
            label: 'Test',
          },
          maxTokens: 500,
        })),
      },
      environments: {
        describe: vi.fn(async () => sandboxEnvironment()),
        forRun: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      },
      tools: { run: vi.fn(async () => ({ ok: true, digest: 'tool digest', content: 'tool content' })) },
      merges: { run: vi.fn(async () => ({ merged: 2 })) },
      bus,
      ...over,
    },
  };
}

const sandboxEnvironment = () => ({
  kind: 'sandbox' as const,
  id: 'engine-run-1',
  capabilities: { kind: 'sandbox' as const, lifecycle: 'invocation' as const },
  workspace: {
    runId: 'run-1',
    ownerId: 'user-1',
    agent: 'koala',
    image: 'registry.access.redhat.com/ubi9/nodejs-22',
    provides: ['bash', 'git', 'node', 'npm'],
    egressMode: 'declared' as const,
    lifetimeMs: 30 * 60_000,
    cpu: '2',
    memory: '2Gi',
    env: [],
    egress: [],
  },
});

const modelArgs = (over: Partial<ModelCallArgs> = {}): ModelCallArgs => ({
  environment: sandboxEnvironment(),
  ticket: ticket(),
  nodeId: 'think',
  tools: 'granted',
  messages: [{ role: 'user', content: 'hello' }],
  ...over,
});

describe('EngineModelCallActivity', () => {
  const sentBody = (fetchImpl: { mock: { calls: unknown[][] } }) =>
    JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string }).body) as {
      messages: { role: string; content: string }[];
      tools?: { function: { name: string } }[];
    };

  const stubbedReply = () => {
    const fetchImpl = vi.fn(async () => streamingResponse([
      frame({ choices: [{ delta: { content: 'ok' } }, { finish_reason: 'stop' }] }),
    ]));
    vi.stubGlobal('fetch', fetchImpl);
    return fetchImpl;
  };

  /**
   * The gap this exists to hold shut: every context test calls the composer directly, so all of
   * them stayed green while nothing in the engine called it and the model was being sent a bare
   * user message with no prompt, no tools and no environment.
   */
  it('sends the agent its own prompt, its environment and its tools — not a bare user message', async () => {
    const fetchImpl = stubbedReply();
    const activities = createEngineActivities(services().services);

    await activities.EngineModelCallActivity(modelArgs());
    const body = sentBody(fetchImpl);

    const system = body.messages.find((message) => message.role === 'system');
    expect(system, 'the model was called with no system prompt at all').toBeDefined();
    expect(system!.content).toContain('YOUR EXECUTION ENVIRONMENT');
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: 'hello' });

    vi.unstubAllGlobals();
  });

  it('offers the tools the agent is granted, and none on a step that allows none', async () => {
    const granted = stubbedReply();
    const activities = createEngineActivities(services().services);

    await activities.EngineModelCallActivity(modelArgs());
    expect(sentBody(granted).tools?.length ?? 0).toBeGreaterThan(0);
    vi.unstubAllGlobals();

    const none = stubbedReply();
    await createEngineActivities(services().services)
      .EngineModelCallActivity(modelArgs({ tools: 'none' }));
    expect(sentBody(none).tools?.length ?? 0).toBe(0);

    vi.unstubAllGlobals();
  });

  it('streams thinking and content onto the bus while returning the finished reply', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse([
      frame({ choices: [{ delta: { reasoning_content: 'weighing it up' } }] }),
      frame({ choices: [{ delta: { content: 'the answer' } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]));
    vi.stubGlobal('fetch', fetchImpl);

    const { services: svc, events } = services();
    const activities = createEngineActivities(svc);

    const outcome = await activities.EngineModelCallActivity(modelArgs());

    expect(outcome.content).toBe('the answer');
    expect(outcome.thinking).toBe('weighing it up');
    expect(outcome.finishReason).toBe('stop');

    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'content')).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: 'run-1', nodeId: 'think' });

    vi.unstubAllGlobals();
  });

  it('reports a stream monitor interrupt back to the workflow', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse([
      frame({ choices: [{ delta: { reasoning_content: 'round and round' } }] }),
      frame({ choices: [{ delta: { content: 'never gets here' } }] }),
    ]));
    vi.stubGlobal('fetch', fetchImpl);

    const spinning: Monitor = { name: 'spinning', onThinking: () => 'caught looping' };
    const { services: svc } = services({ streamMonitors: () => [spinning] });
    const activities = createEngineActivities(svc);

    const outcome = await activities.EngineModelCallActivity(modelArgs());

    expect(outcome.interrupted).toBe('caught looping (spinning)');
    expect(outcome.content).toBe('');

    vi.unstubAllGlobals();
  });

  it('resolves the endpoint per agent rather than globally', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamingResponse([])));
    const { services: svc } = services();
    const activities = createEngineActivities(svc);

    await activities.EngineModelCallActivity(modelArgs({ ticket: ticket({ agentSlug: 'research' }) }));

    expect(svc.endpoints.forAgent).toHaveBeenCalledWith({ ownerId: 'user-1', agentSlug: 'research' });
    vi.unstubAllGlobals();
  });
});

describe('the remaining engine activities', () => {
  it('delegates tool calls to the tool runtime', async () => {
    const { services: svc } = services();
    const activities = createEngineActivities(svc);

    const outcome = await activities.EngineToolActivity({
      ticket: ticket(),
      nodeId: 'work',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    });

    expect(outcome).toMatchObject({ ok: true, digest: 'tool digest' });
    expect(svc.tools.run).toHaveBeenCalledWith(expect.objectContaining({ name: 'read_file' }));
  });

  it('delegates a custom merge strategy to its runtime', async () => {
    const { services: svc } = services();
    const activities = createEngineActivities(svc);

    expect(await activities.EngineMergeActivity({
      ticket: ticket(), nodeId: 'join', strategy: 'conflict-resolver', children: [],
    })).toEqual({ merged: 2 });
  });

  it('resolves and releases the run environment through the resolver, keyed by the run', async () => {
    const { services: svc } = services();
    const activities = createEngineActivities(svc);

    expect(await activities.EngineResolveEnvironmentActivity({ ticket: ticket() }))
      .toMatchObject({ kind: 'sandbox', id: 'engine-run-1' });

    await activities.EngineReleaseEnvironmentActivity({ ticket: ticket(), environmentId: 'engine-run-1' });

    expect(svc.environments.release).toHaveBeenCalledWith('run-1');
  });

  it('publishes workflow-side events onto the bus', async () => {
    const { services: svc, events } = services();
    const activities = createEngineActivities(svc);

    await activities.EnginePublishActivity({
      events: [
        { type: 'run.started', runId: 'run-1', at: 'now', agentId: 'koala', loopId: 'interactive-chat' },
        { type: 'notice', runId: 'run-1', at: 'now', level: 'info', message: 'waiting on you' },
      ],
    });

    expect(events.map((e) => e.type)).toEqual(['run.started', 'notice']);
  });
});
