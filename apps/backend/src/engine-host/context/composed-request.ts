import {
  ALL_SEEDED_AGENTS,
  contractsFor,
  BUILDER_TOOLS,
  type ModelProvider,
} from '@koala/agent-engine';
import {
  BUILT_IN_GROUPS,
  builtInCatalogue,
  runProcedure,
  type Procedure,
  type ProcedureResult,
} from '@koala/agent-engine/procedure';
import type { ToolContract } from '@koala/engine-core';
import { ENGINE_TOOL_SEEDS } from '../tools/engine-tool-seeds.js';
import { createAgentRegistry } from '../registries/registry.js';
import { createEnvironmentResolver } from '../sandboxes/environments.js';
import { createRunEnvironments } from '../sandboxes/run-environments.js';
import { createSandboxDriver } from '../drivers/sandbox.js';
import { createProcedureExecutor, type HostNodeServices } from '../nodes/index.js';
import type { ToolCallArgs, ToolCallOutcome } from '../temporal/contracts.js';

export interface ComposedRequest {
  system: string;
  messages: { role: string; content: string; tool_call_id?: string }[];
  toolNames: string[];
  maxTokens: number;
}

export interface ScriptedReply {
  content?: string;
  thinking?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  finishReason?: string;
}

export interface ComposeOptions {
  procedure: Procedure;
  agent: string;
  message?: string;
  inputs?: Record<string, unknown>;
  replies?: readonly ScriptedReply[];
  tools?: (args: ToolCallArgs) => Promise<ToolCallOutcome>;
  answers?: Record<string, unknown>;
  ownerId?: string;
}

export interface Composed {
  requests: ComposedRequest[];
  result: ProcedureResult;
}

const PROVIDER = {
  id: 'test-endpoint',
  name: 'Test',
  source: 'deployment',
  model: 'test-model',
  contextTokens: 32_000,
} as ModelProvider;

export const CATALOGUE: ToolContract[] = [
  ...contractsFor(ENGINE_TOOL_SEEDS, ['draft', 'approved']),
  ...contractsFor(BUILDER_TOOLS, ['draft', 'approved']),
];

const framesFor = (reply: ScriptedReply): string[] => {
  const frames: string[] = [];
  if (reply.thinking) frames.push(JSON.stringify({ choices: [{ delta: { reasoning_content: reply.thinking } }] }));
  if (reply.content) frames.push(JSON.stringify({ choices: [{ delta: { content: reply.content } }] }));
  for (const [index, call] of (reply.toolCalls ?? []).entries()) {
    frames.push(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] } }],
    }));
  }
  const finish = reply.finishReason ?? (reply.toolCalls?.length ? 'tool_calls' : 'stop');
  frames.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] }));
  return frames;
};

export async function composedRequests(options: ComposeOptions): Promise<Composed> {
  const replies = options.replies ?? [{ content: 'All done.' }];
  const sent: ComposedRequest[] = [];
  let turn = 0;

  const fetchImpl = async (_url: string, init: { body: string }): Promise<Response> => {
    const body = JSON.parse(init.body) as {
      messages: { role: string; content: string; tool_call_id?: string }[];
      tools?: { function: { name: string } }[];
      max_tokens: number;
    };
    sent.push({
      system: body.messages.find((message) => message.role === 'system')?.content ?? '',
      messages: body.messages.filter((message) => message.role !== 'system'),
      toolNames: (body.tools ?? []).map((tool) => tool.function.name),
      maxTokens: body.max_tokens,
    });

    const frames = framesFor(replies[Math.min(turn, replies.length - 1)]!);
    turn += 1;

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      body: (async function* () {
        for (const frame of frames) yield `data: ${frame}\n`;
        yield 'data: [DONE]\n';
      })(),
    } as unknown as Response;
  };

  const registry = createAgentRegistry({
    agentStore: { list: async () => ALL_SEEDED_AGENTS() },
    toolCatalogue: { list: async () => CATALOGUE },
  });

  const resolver = createEnvironmentResolver({
    registry,
    environments: createRunEnvironments({
      provision: async ({ id, spec }) => createSandboxDriver({
        sandboxId: id,
        spec,
        backend: {
          exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          readFile: async () => '',
          writeFile: async () => undefined,
          listDir: async () => [],
          deleteFile: async () => undefined,
        },
      }),
    }),
    images: { ensure: async (plan) => plan.base, exists: async () => true, start: async (plan) => ({ state: 'ready' as const, reference: plan.base }), standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }) },
    tools: async () => [],
  });

  const services: HostNodeServices = {
    registry,
    models: { resolveBaseUrl: async () => ({ provider: PROVIDER, baseUrl: 'https://models.test/v1', apiKey: 'k' }) },
    tools: { run: options.tools ?? (async () => ({ ok: true, digest: 'done', content: 'done' })) },
    environments: {
      describe: (ticket) => resolver.describe(ticket),
      release: (runId) => resolver.release(runId),
    },
    memories: { list: async () => [], save: async () => undefined },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };

  const ownerId = options.ownerId ?? 'user-1';
  const result = await runProcedure({
    procedure: options.procedure,
    catalogue: builtInCatalogue(),
    groups: BUILT_IN_GROUPS,
    executor: createProcedureExecutor(services, {
      registry,
      approve: async () => true,
      ask: async ({ nodeId }) => {
        const value = options.answers?.[nodeId];
        return value === undefined
          ? { answered: false, reason: `nothing answers "${nodeId}" here` }
          : { answered: true, value };
      },
    }),
    identity: {
      runId: `composed-${options.agent}`,
      depth: 0,
      agentId: options.agent,
      loopId: options.procedure.id,
      loopVersion: options.procedure.version,
      trigger: 'user',
    },
    launch: { ownerId },
    inputs: { ...(options.inputs ?? {}), message: options.message ?? 'get on with it' },
  });

  return { requests: sent, result };
}

export const said = (request: ComposedRequest): string =>
  request.messages.map((message) => message.content).join('\n');
