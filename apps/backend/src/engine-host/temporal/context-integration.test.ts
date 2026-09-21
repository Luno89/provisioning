import { describe, it, expect, vi, afterEach } from 'vitest';
import { BUILT_IN_GROUPS, builtInCatalogue, runProcedure } from '@koala/agent-engine/procedure';
import { LEVEL1_PROCEDURE } from '../../eval/level1/attempt.js';
import { createProcedureExecutor, type HostNodeServices } from '../nodes/index.js';
import { createAgentRegistry } from '../registries/registry.js';
import { createEnvironmentResolver, type WorkspaceSource } from '../sandboxes/environments.js';
import { createRunEnvironments } from '../sandboxes/run-environments.js';
import { createSandboxDriver } from '../drivers/sandbox.js';
import { createEventBus, type AgentDefinition } from '@koala/agent-engine';
import type { ToolContract } from '@koala/engine-core';

const CATALOGUE: ToolContract[] = [
  { name: 'run_command', description: 'Run a shell command', binding: 'environment', requires: { terminal: true } },
  { name: 'read_file', description: 'Read a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'search_web', description: 'Search the web', binding: 'network' },
  { name: 'propose_work', description: 'Propose a unit of work', binding: 'platform' },
];
import type { MachineBackend } from '../drivers/machine.js';
import type { RunTicket } from './contracts.js';
import { inMemoryConversations } from '../nodes/conversation-nodes.js';

const ticket = (agentSlug: string, over: Partial<RunTicket> = {}): RunTicket => ({
  runId: 'run-1',
  depth: 0,
  ownerId: 'user-1',
  agentSlug,
  trigger: 'user',
  ...over,
});

const agent = (over: Partial<AgentDefinition> & Pick<AgentDefinition, 'slug'>): AgentDefinition => ({
  name: over.slug,
  description: `the ${over.slug} agent`,
  version: '1',
  prompt: 'You are here to do one job well.',
  procedure: 'tool-rounds',
  guidance: '',
  returns: '',
  failures: [],
  tools: [],
  budget: { maxRounds: 4 },
  environment: {},
  ...over,
});

const BUILDER = agent({
  slug: 'builder',
  prompt: 'You build things.',
  tools: ['run_command', 'read_file', 'search_web'],
  environment: { terminal: true, filesystem: true, languages: ['node'] },
  interface: { workspace: true },
});

const THINKER = agent({
  slug: 'thinker',
  prompt: 'You only think.',
  tools: ['propose_work'],
  environment: {},
});

const machineBackend = (): MachineBackend => ({
  exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(async () => undefined),
  listDir: vi.fn(async () => []),
  deleteFile: vi.fn(async () => undefined),
});

function sandboxDriverFor({ id, spec }: { id: string; spec: Parameters<typeof createSandboxDriver>[0]['spec'] }) {
  return createSandboxDriver({
    sandboxId: id,
    spec,
    backend: {
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      readFile: async () => '',
      writeFile: async () => undefined,
      listDir: async () => [],
      deleteFile: async () => undefined,
    },
  });
}

function engine(options: {
  agents: AgentDefinition[];
  workspaces?: WorkspaceSource | undefined;
  withMachine?: boolean | undefined;
}) {
  const registry = createAgentRegistry({
    agentStore: { list: async () => options.agents },
    toolCatalogue: { list: async () => CATALOGUE },
  });

  const environments = createEnvironmentResolver({
    registry,
    environments: createRunEnvironments({ provision: async (request) => sandboxDriverFor(request) }),
    images: { ensure: async (plan) => plan.base, exists: async () => true, start: async (plan) => ({ state: 'ready' as const, reference: plan.base }), standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }) },
    tools: async () => [],
    ...(options.workspaces ? { workspaces: options.workspaces } : {}),
    ...(options.withMachine ? { machineBackend: machineBackend() } : {}),
  });

  const services: HostNodeServices = {
    conversations: inMemoryConversations(),
    registry,
    environments,
    models: {
      resolveBaseUrl: async () => ({
        provider: { id: `bucket-${Math.random()}`, name: 'Test', source: 'deployment', model: 'test-model', contextTokens: 32_000 } as never,
        baseUrl: 'https://models.test/v1',
        apiKey: 'k',
      }),
    },
    tools: { run: async () => ({ ok: true, digest: '', content: '' }) },
    memories: { list: async () => [], save: async () => undefined },
  };

  return { services, registry, environments };
}

function stubModel() {
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => '',
    body: (async function* () {
      yield `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n`;
    })(),
  } as unknown as Response));

  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

const GROUPS_WITHOUT_TOOLS = BUILT_IN_GROUPS.map((group) => (group.id === 'model-turn'
  ? {
    ...group,
    nodes: group.nodes.map((node) => (node.id === 'tools' ? { ...node, settings: { ...node.settings, offer: 'none' } } : node)),
  }
  : group));

async function callWith(
  world: ReturnType<typeof engine>,
  run: RunTicket,
  over: { tools?: 'granted' | 'none' } = {},
) {
  const fetchImpl = stubModel();
  const environment = await world.environments.describe(run);

  await runProcedure({
    procedure: LEVEL1_PROCEDURE,
    catalogue: builtInCatalogue(),
    groups: over.tools === 'none' ? GROUPS_WITHOUT_TOOLS : BUILT_IN_GROUPS,
    executor: createProcedureExecutor(world.services, { registry: world.registry }),
    identity: {
      runId: run.runId,
      depth: run.depth,
      agentId: run.agentSlug,
      loopId: LEVEL1_PROCEDURE.id,
      loopVersion: LEVEL1_PROCEDURE.version,
      trigger: 'user',
    },
    launch: { ownerId: run.ownerId },
    inputs: { message: 'get on with it' },
  });

  const sent = fetchImpl.mock.calls[0] as unknown as [string, { body: string }] | undefined;
  if (!sent) throw new Error('the model was never called');

  const body = JSON.parse(sent[1].body) as {
    messages: { role: string; content: string }[];
    tools?: { function: { name: string } }[];
  };

  return {
    system: body.messages.find((message) => message.role === 'system')?.content ?? '',
    messages: body.messages,
    toolNames: (body.tools ?? []).map((tool) => tool.function.name),
    environment,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a sandbox agent, end to end', () => {
  const activities = () => engine({ agents: [BUILDER] });

  it('is told about the image the resolver actually chose for it', async () => {
    const { system, environment } = await callWith(activities(), ticket('builder'));

    expect(environment.kind).toBe('sandbox');
    expect(system).toContain('ubi9/nodejs-22');
    expect(system).toMatch(/Available:.*npm/);
    expect(system).toMatch(/NOT installed:.*go/);
  });

  it('is told the network truth that matches its own NetworkPolicy rules', async () => {
    const { system, environment } = await callWith(activities(), ticket('builder'));

    const rules = environment.kind === 'sandbox' ? environment.workspace.egress : [];
    expect(rules).toContainEqual(expect.objectContaining({ namespace: 'koala-registry' }));
    expect(system).toContain('koala-registry');
    expect(system).toContain('npm install');
  });

  it('leads with its own prompt, and ends with the user turn', async () => {
    const { system, messages } = await callWith(activities(), ticket('builder'));

    expect(system.startsWith('You build things.')).toBe(true);
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'get on with it' });
  });

  it('is offered exactly the tools it was granted', async () => {
    const { toolNames } = await callWith(activities(), ticket('builder'));

    expect(toolNames.sort()).toEqual(['read_file', 'run_command', 'search_web']);
  });

  it('gets second-person wording because it is the one in the container', async () => {
    const { system } = await callWith(activities(), ticket('builder'));

    expect(system).toContain('You run shell commands');
    expect(system).not.toContain('WHERE THE WORK YOU PROPOSE WILL RUN');
  });

  it('is offered nothing, and told so, on a step that allows no tools', async () => {
    const { system, toolNames } = await callWith(activities(), ticket('builder'), { tools: 'none' });

    expect(toolNames).toEqual([]);
    expect(system).toContain('NOT AVAILABLE TO YOU THIS TURN');
    expect(system).toContain('run_command');
  });
});

describe('an agent that delegates rather than doing, end to end', () => {
  const HANDS = agent({
    slug: 'hands',
    tools: ['run_command'],
    environment: { terminal: true, filesystem: true, languages: ['node'] },
    interface: { workspace: true },
  });

  const LEAD = agent({
    slug: 'lead',
    prompt: 'You break work down.',
    tools: ['propose_work'],
    agents: ['hands'],
    environment: {},
  });

  it('is told where the work it proposes will run, in the third person, with no shell of its own', async () => {
    const { system, toolNames } = await callWith(engine({ agents: [LEAD, HANDS] }), ticket('lead'));

    expect(system).toContain('WHERE THE WORK YOU PROPOSE WILL RUN');
    expect(system).not.toContain('You run shell commands');
    expect(toolNames).toContain('hands');
  });
});

describe('an agent with no machine, end to end', () => {
  it('is not told it has a shell it does not have, and is offered no shell tools', async () => {
    const { system, toolNames, environment } = await callWith(
      engine({ agents: [THINKER] }),
      ticket('thinker'),
    );

    expect(environment).toMatchObject({ kind: 'none', egress: false });
    expect(system).toContain('You have no machine this turn');
    expect(system).not.toContain('You run shell commands');
    expect(toolNames).toEqual(['propose_work']);
  });

  it('names a granted tool it cannot use here, with the reason', async () => {
    const needsShell = agent({
      slug: 'confused',
      prompt: 'You think you can build.',
      tools: ['propose_work', 'run_command'],
      environment: {},
    });

    const { system, toolNames } = await callWith(engine({ agents: [needsShell] }), ticket('confused'));

    expect(toolNames).toEqual(['propose_work']);
    expect(system).toContain('NOT AVAILABLE TO YOU THIS TURN');
    expect(system).toMatch(/run_command: .*(command|machine)/);
  });
});

describe('an agent on your own machine, end to end', () => {
  const onMachine: WorkspaceSource = {
    forRun: async () => ({
      kind: 'machine', deviceId: 'tallgeese', deviceName: 'Tallgeese', path: 'code/thing',
    }),
  };

  it('is told plainly that this is not a sandbox, and where it is confined', async () => {
    const { system, environment } = await callWith(
      engine({ agents: [BUILDER], workspaces: onMachine, withMachine: true }),
      ticket('builder'),
    );

    expect(environment.kind).toBe('machine');
    expect(system).toContain('Tallgeese');
    expect(system).toContain('not a sandbox');
    expect(system).toContain('code/thing');
    expect(system).not.toContain('destroyed after');
  });
});

describe('what the egress mode changes in the prompt', () => {
  const withMode = (mode: AgentDefinition['egressMode']) =>
    engine({ agents: [{ ...BUILDER, egressMode: mode }] });

  it('tells a declared-allowlist agent that retrying a blocked host is pointless', async () => {
    const { system } = await callWith(withMode('declared'), ticket('builder'));

    expect(system).toMatch(/no retry changes that/);
    expect(system).not.toContain('Outbound network is open');
  });

  it('tells an auto-egress agent the network is open, rather than implying a wall', async () => {
    const { system } = await callWith(withMode('auto'), ticket('builder'));

    expect(system).toContain('Outbound network is open');
    expect(system).not.toMatch(/no retry changes that/);
  });

  it('opens the pod to the egress proxy only when the agent is allowed out', async () => {
    const declared = await callWith(withMode('declared'), ticket('builder'));
    const auto = await callWith(withMode('auto'), ticket('builder'));

    const proxied = (result: { environment: { kind: string } }) => {
      const environment = result.environment as { kind: string; workspace?: { egress?: { namespace?: string }[] } };
      return (environment.workspace?.egress ?? []).some((rule) => rule.namespace === 'koala-egress');
    };

    expect(proxied(declared)).toBe(false);
    expect(proxied(auto)).toBe(true);
  });

  it('tells an agent that can ask how to ask, and one that cannot, nothing', async () => {
    const canAsk = engine({
      agents: [{ ...BUILDER, egressMode: 'request', tools: [...BUILDER.tools, 'request_egress'] }],
    });

    expect((await callWith(canAsk, ticket('builder'))).system).toContain('request_egress');
    expect((await callWith(withMode('request'), ticket('builder'))).system).not.toContain('request_egress');
  });
});
