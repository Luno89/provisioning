import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BUILT_IN_GROUPS,
  INTERACTIVE_CHAT_V4,
  builtInCatalogue,
  runProcedure,
} from '@koala/agent-engine/procedure';
import { ALL_SEEDED_AGENTS, contractsFor, createEventBus } from '@koala/agent-engine';
import type { ToolContract } from '@koala/engine-core';
import { createAgentRegistry } from './registries/registry.js';
import { createEnvironmentResolver } from './sandboxes/environments.js';
import { createRunEnvironments } from './sandboxes/run-environments.js';
import { createProcedureExecutor, type HostNodeServices } from './nodes/index.js';
import { inMemoryConversations } from './nodes/conversation-nodes.js';
import { createSecretTools } from './tools/secret-tools.js';
import { SECRET_TOOLS } from './tools/secret-tools-catalogue.js';
import { createToolRuntime } from './tools/tool-runtime.js';
import { MemoryDB } from '../lib/memory-db.js';
import { SecretRequestService, createSecretVault } from '../services/SecretRequestService.js';
import type { Tree } from '../lib/trees.js';

const TYPED = 'sk_live_TYPED_SENTINEL_4b1f9c';
const MINTED = 'gitea_MINTED_SENTINEL_77ad02';

const koala = ALL_SEEDED_AGENTS().find((agent) => agent.slug === 'koala')!;

function vaultBackend() {
  const held = new Map<string, string>();
  return {
    held,
    hasSecret: async (projectId: string, key: string) => held.has(`${projectId}/${key}`),
    listSecrets: async (projectId: string) => [...held.keys()].filter((entry) => entry.startsWith(`${projectId}/`)).map((entry) => ({ key: entry.split('/')[1]! })),
    setSecret: async (projectId: string, key: string, value: string) => {
      held.set(`${projectId}/${key}`, value);
      return { secretReference: `secret://${projectId}/${key}` };
    },
  };
}

function sse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => '',
    body: (async function* () { yield `data: ${JSON.stringify(payload)}\n\n`; })(),
  } as unknown as Response;
}

const call = (id: string, args: unknown) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'request_secret', arguments: JSON.stringify(args) } }] }, finish_reason: null }],
});

describe('a secret never reaches the model, a trace, an event or a conversation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('holds for a value the person types, one the platform mints, and one the model tries to send', async () => {
    const db = new MemoryDB();
    await db.init();
    await db.saveProject({ id: 'project-9', name: 'billing', ownerId: 'user-1', appType: 'gitapp', createdAt: 'now' });
    const tree: Tree = { id: 'tree-1', ownerId: 'user-1', name: 'Billing', type: 'application', goal: 'Take payments.', projectIds: ['project-9'], createdAt: 'now', updatedAt: 'now' };

    const conversations = inMemoryConversations();
    await conversations.save({ id: 'conv-1', ownerId: 'user-1', title: 'Billing', messages: [], treeId: 'tree-1', createdAt: 'now', updatedAt: 'now' });

    const backend = vaultBackend();
    const vault = createSecretVault({ backend, minters: { readToken: async () => MINTED } });
    const service = new SecretRequestService({ store: db, vault: backend });

    const handlers = createSecretTools({
      vault,
      stores: {
        requests: { list: (ownerId, filter) => db.getSecretRequests(ownerId, filter), save: (request) => db.saveSecretRequest(request) },
        projects: { list: () => db.getProjects(), save: (project) => db.saveProject(project) },
        trees: { list: async () => [tree] },
        binding: async (ownerId, conversationId) => {
          const conversation = await conversations.get(ownerId, conversationId);
          return conversation ? { treeId: conversation.treeId, projectId: conversation.projectId } : undefined;
        },
      },
    });

    const registry = createAgentRegistry({
      agentStore: { list: async () => [koala] },
      toolCatalogue: { list: async () => contractsFor(SECRET_TOOLS) },
    });
    const environments = createEnvironmentResolver({
      registry,
      environments: createRunEnvironments({ provision: async () => { throw new Error('koala needs no sandbox'); } }),
      images: {
        ensure: async (plan) => plan.base,
        exists: async () => true,
        start: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
        standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
      },
      tools: async () => [],
    });
    const services: HostNodeServices = {
      conversations,
      registry,
      environments,
      models: {
        resolveBaseUrl: async () => ({
          provider: { id: 'bucket-1', name: 'Test', source: 'deployment', model: 'test-model', contextTokens: 32_000 } as never,
          baseUrl: 'https://models.test/v1',
          apiKey: 'k',
        }),
      },
      tools: createToolRuntime({ registry, handlers }),
      memories: { list: async () => [], save: async () => undefined },
    };

    let round = 0;
    const fetchImpl = vi.fn(async () => {
      round += 1;
      if (round === 1) return sse(call('c1', { key: 'STRIPE_API_KEY', description: 'The live Stripe secret key, from the Stripe dashboard.' }));
      if (round === 2) {
        const [request] = await service.list('user-1', { conversationId: 'conv-1' });
        const submitted = await service.submit('user-1', request!.id, TYPED);
        expect(submitted.ok).toBe(true);
        return sse(call('c2', { key: 'STRIPE_API_KEY', description: 'Checking it arrived.' }));
      }
      if (round === 3) return sse(call('c3', { key: 'GITEA_TOKEN', description: 'To clone the repo at run time.' }));
      if (round === 4) return sse(call('c4', { key: 'WEBHOOK_SECRET', description: 'Stripe webhooks.', value: 'whsec_model_invented' }));
      if (round === 5) return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c5', function: { name: 'list_project_secrets', arguments: '{}' } }] }, finish_reason: null }] });
      return sse({ choices: [{ delta: { content: 'Stripe is set, the Gitea token was provisioned.' }, finish_reason: 'stop' }] });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const events: unknown[] = [];
    const traces: unknown[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => { events.push(event); });

    const result = await runProcedure({
      procedure: INTERACTIVE_CHAT_V4,
      catalogue: builtInCatalogue(),
      groups: BUILT_IN_GROUPS,
      executor: createProcedureExecutor(services, { registry }),
      identity: { runId: 'run-s4', depth: 0, agentId: 'koala', loopId: INTERACTIVE_CHAT_V4.id, loopVersion: INTERACTIVE_CHAT_V4.version, trigger: 'user' },
      launch: { ownerId: 'user-1', conversationId: 'conv-1' },
      inputs: { message: 'Wire up Stripe for the billing service.', conversationId: 'conv-1', treeId: 'tree-1' },
      bus,
      onTrace: (trace) => { traces.push(trace); },
    });
    expect(result.outcome).toBe('ok');

    expect(backend.held.get('project-9/STRIPE_API_KEY')).toBe(TYPED);
    expect(backend.held.get('project-9/GITEA_TOKEN')).toBe(MINTED);
    expect(backend.held.has('project-9/WEBHOOK_SECRET')).toBe(false);

    const requests = await db.getSecretRequests('user-1');
    expect(requests.map((request) => [request.key, request.status])).toEqual([
      ['STRIPE_API_KEY', 'provided'],
      ['GITEA_TOKEN', 'provisioned'],
    ]);
    const project = (await db.getProjects()).find((candidate) => candidate.id === 'project-9')!;
    expect(project.requiredSecrets).toEqual([{ key: 'STRIPE_API_KEY', source: 'person' }, { key: 'GITEA_TOKEN', source: 'gitea-read-token' }]);

    const modelSaw = fetchImpl.mock.calls.map((args) => String((args as unknown as [string, RequestInit])[1].body)).join('\n');
    expect(modelSaw).toContain('secret://project-9/STRIPE_API_KEY');
    expect(modelSaw).toContain('never send a secret value');
    expect(modelSaw).toContain('- GITEA_TOKEN (secret://project-9/GITEA_TOKEN): in the vault');

    const everywhere = {
      modelSaw,
      events: JSON.stringify(events),
      traces: JSON.stringify(traces),
      outputs: JSON.stringify(result.outputs),
      conversation: JSON.stringify(await conversations.get('user-1', 'conv-1')),
      requests: JSON.stringify(requests),
      project: JSON.stringify(project),
    };
    for (const [where, text] of Object.entries(everywhere)) {
      expect(text, where).not.toContain(TYPED);
      expect(text, where).not.toContain(MINTED);
    }
  });
});
