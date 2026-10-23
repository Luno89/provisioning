import { afterEach, describe, expect, it } from 'vitest';
import { startTelemetry, type Telemetry, type TelemetrySink, type TelemetrySignal } from '@koala/engine-core/telemetry-sdk';
import { callModel } from './model-call.js';
import { createOrchestrationNodes } from '../procedure/nodes/orchestration.js';
import { runToolCalls } from '../procedure/nodes/tools.js';
import type { NodeRequest, StepResult } from '../procedure/interpreter.js';
import { defaultSettings } from '../procedure/settings-schema.js';
import { createRunState } from '../runtime/run.js';
import type { AgentDefinition } from '../agent/agent.js';

const SAID = 'zebra-7f3a-the-person-typed-this';
const SYSTEM = 'kingfisher-91c2-the-prompt-says-this';
const TOOL_HELP = 'otter-55d1-a-tool-description';
const REPLIED = 'heron-2b8e-the-model-answered-this';
const THOUGHT = 'lynx-c0de-the-model-thought-this';
const ARGUMENTS = 'badger-e4f0-the-arguments-held-this';
const OUTPUT = 'marmot-77aa-the-tool-printed-this';
const FILE_TEXT = 'walrus-d9d9-a-file-held-this';

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n`;
const streaming = (chunks: string[]) => ({
  ok: true, status: 200, headers: new Headers(), text: async () => chunks.join(''),
  body: (async function* () { for (const chunk of chunks) yield chunk; })(),
}) as unknown as Response;

const collecting = (): TelemetrySink & { text(): string } => {
  const bodies: string[] = [];
  return {
    text: () => bodies.join('\n'),
    async send(_signal: TelemetrySignal, body: Uint8Array) { bodies.push(Buffer.from(body).toString('utf8')); },
  };
};

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let telemetry: Telemetry | undefined;
afterEach(async () => { await telemetry?.shutdown(); telemetry = undefined; });

describe('nothing a person typed enters telemetry', () => {
  it('keeps prompts, replies, thinking, tool arguments, tool output and file contents out of every span and metric', async () => {
    const sink = collecting();
    telemetry = startTelemetry({ service: 'koala-test', sink, spanDelayMs: 10, metricsEveryMs: 50, log: () => undefined });

    const answered = await callModel({
      endpoint: { baseUrl: 'https://models.test/v1', model: 'glm-4', rateLimitKey: 'scrub-bucket', ownerId: 'owner-1', label: 'Tabby' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: SAID }],
      tools: [{ type: 'function', function: { name: 'read_file', description: TOOL_HELP, parameters: { type: 'object', properties: {} } } }],
      maxTokens: 100,
      fetchImpl: (async () => streaming([
        frame({ choices: [{ delta: { reasoning_content: THOUGHT } }] }),
        frame({ choices: [{ delta: { content: REPLIED } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: JSON.stringify({ path: ARGUMENTS }) } }] } }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 9 } }),
      ])) as unknown as typeof fetch,
    });
    expect(answered.content).toBe(REPLIED);

    const persona: AgentDefinition = {
      slug: 'worker', name: 'Worker', description: 'works', version: '1', prompt: SYSTEM, procedure: 'tool-rounds',
      guidance: '', returns: '', failures: [], tools: ['read_file'], agents: [], budget: {}, environment: {},
    };
    const nodes = createOrchestrationNodes({
      runTool: async () => ({ ok: true, digest: OUTPUT, content: `${OUTPUT}\n${FILE_TEXT}` }),
      runChild: async () => ({ runId: 'child', agentId: 'research', outcome: 'ok', outputs: {} }),
      approve: async () => true,
      ask: async () => ({ answered: true, value: SAID }),
    } as never);
    const step = nodes.find((candidate) => candidate.kind === runToolCalls.definition.kind)!;
    const request: NodeRequest = {
      node: { id: 'tools', kind: runToolCalls.definition.kind, settings: defaultSettings(runToolCalls.definition.settings), position: { x: 0, y: 0 } },
      origin: 'tools',
      definition: runToolCalls.definition,
      inputs: {
        reply: { id: 'turn#1', content: REPLIED, thinking: THOUGHT, finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: ARGUMENTS }) }] },
        persona,
        environment: { kind: 'none', egress: false },
      },
      execution: 1,
      run: {
        identity: { runId: 'run-7', depth: 0, agentId: 'worker', loopId: 'tool-rounds', loopVersion: '2', trigger: 'user' },
        launch: { ownerId: 'owner-1' },
        handles: {},
        inputs: { message: SAID },
        counters: createRunState(0).counters,
        budget: {},
        cleaningUp: false,
        emit: () => undefined,
      },
    };
    const result = (await step.run(request)) as StepResult & { outputs: { results: { content: string }[] } };
    expect(result.outputs.results[0]!.content).toContain(OUTPUT);

    await settle(120);
    await telemetry.flush();
    const sent = sink.text();
    expect(sent).toContain('model.call');
    expect(sent).toContain('tool.call');
    expect(sent).toContain('glm-4');
    expect(sent).toContain('read_file');
    expect(sent).toContain('koala_model_tokens');
    expect(sent).toContain('koala_tool_call_seconds');
    for (const text of [SAID, SYSTEM, TOOL_HELP, REPLIED, THOUGHT, ARGUMENTS, OUTPUT, FILE_TEXT]) {
      expect(sent, `${text} leaked into telemetry`).not.toContain(text);
    }
  });
});
