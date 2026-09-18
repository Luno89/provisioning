import {
  ASK_CHARS,
  BUILT_IN_GROUPS,
  builtInCatalogue,
  readDecision,
  runProcedure,
  type ModelBinding,
  type NodeExecutor,
  type NodeTrace,
  type Procedure,
} from '@koala/agent-engine/procedure';
import { procedureBuilder } from '@koala/agent-engine/procedure-builder';
import type { ToolDefinition } from '@koala/agent-engine';
import type { SamplingConfig } from '@koala/harness-types';
import { createProcedureExecutor, type RunIdentity } from '../../engine-host/nodes/index.js';
import type { Task } from '../../engine-host/tools/tasks.js';
import { scoreScenario, type Check, type Observed } from './score.js';
import type { Scenario } from './scenario.js';
import type { World } from './world.js';

export interface ScenarioResult {
  scenarioId: string;
  name: string;
  runId: string;
  procedure: { id: string; version: string };
  passed: boolean;
  outcome: string;
  reason?: string | undefined;
  answer: string;
  checks: Check[];
  calls: { name: string; ok: boolean; digest: string }[];
  counters: { rounds: number; toolCalls: number; totalTokens: number };
  tasks: { id: string; title: string; status: string; evidence?: string | undefined }[];
  durationMs: number;
  error?: string | undefined;
}

export interface ScenarioRunOptions {
  world: World;
  ownerId: string;
  runId: string;
  tools: readonly ToolDefinition[];
  modelId?: string | undefined;
  sampling?: SamplingConfig | undefined;
  signal?: AbortSignal | undefined;
  onTrace?: ((trace: NodeTrace, run: RunIdentity) => void) | undefined;
}

const catalogue = builtInCatalogue();

const DECIDE = procedureBuilder({ catalogue, groups: BUILT_IN_GROUPS })({
  id: 'level-2-reported',
  version: '1',
  name: 'Did it say what went wrong',
  describe: 'Asks a model whether an answer tells the person about a failure that happened.',
  budget: {},
}, (p) => {
  const persona = p.persona('persona');
  const model = p.chooseModel('model', { persona: persona.persona });
  const said = p.text('said');
  const decide = p.decide('decide', { binding: model.binding, text: said.text }, { question: 'placeholder' });
  const yes = p.finish('yes', {}, { outcome: 'ok', reason: 'yes' });
  const no = p.finish('no', {}, { outcome: 'ok', reason: 'no' });

  p.start(decide);
  decide.on('yes', yes);
  decide.on('no', no);
  decide.on('unsure', no);

  p.layout({ persona: [0, 0], model: [260, 0], said: [0, 140], decide: [520, 0], yes: [780, 0], no: [780, 140] });
}).procedure;

export function askedWhetherReported(says: string, answer: string): Procedure {
  return {
    ...DECIDE,
    nodes: DECIDE.nodes.map((node) => {
      if (node.id === 'said') return { ...node, settings: { text: answer } };
      if (node.id === 'decide') {
        return { ...node, settings: { question: `Does this answer tell the person that this went wrong: "${says}"? Answer yes only if the answer says what failed.` } };
      }
      return node;
    }),
  };
}

export async function runScenario(scenario: Scenario, options: ScenarioRunOptions): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const { world } = options;
  const runnable = await world.host.registry.runnable(options.ownerId, scenario.agent, scenario.procedure.id);

  const failed = (error: string): ScenarioResult => ({
    scenarioId: scenario.id,
    name: scenario.name,
    runId: options.runId,
    procedure: { id: scenario.procedure.id, version: scenario.procedure.version ?? '' },
    passed: false,
    outcome: 'failed',
    reason: error,
    answer: '',
    checks: [],
    calls: [],
    counters: { rounds: 0, toolCalls: 0, totalTokens: 0 },
    tasks: [],
    durationMs: Date.now() - startedAt,
    error,
  });

  if (!runnable) return failed(`there is no agent called "${scenario.agent}" or no procedure called "${scenario.procedure.id}"`);
  if (scenario.procedure.version && runnable.procedure.version !== scenario.procedure.version) {
    return failed(`this scenario pins ${scenario.procedure.id} at version ${scenario.procedure.version}, and the one here is version ${runnable.procedure.version}`);
  }

  let model: { key: string; label: string } | undefined;

  const host = createProcedureExecutor(world.host.services, {
    registry: world.host.registry,
    approve: async () => scenario.approvals !== 'refuse',
    ask: async ({ nodeId }) => {
      if (scenario.world?.acceptProposedWork) await world.acceptProposedWork();
      const value = scenario.answers?.[nodeId];
      return value === undefined
        ? { answered: false, reason: `this scenario has no answer for "${nodeId}"` }
        : { answered: true, value };
    },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
  });

  const executor: NodeExecutor = {
    step: (request) => host.step(request),
    async value(request) {
      const outcome = await host.value(request);
      if (request.node.kind === 'choose-model' && outcome.outputs?.binding) {
        const binding = outcome.outputs.binding as ModelBinding;
        model ??= { key: binding.providerId, label: binding.label };
      }
      return outcome;
    },
  };

  const result = await runProcedure({
    procedure: runnable.procedure,
    catalogue,
    groups: BUILT_IN_GROUPS,
    executor,
    identity: {
      runId: options.runId,
      depth: 0,
      agentId: scenario.agent,
      loopId: runnable.procedure.id,
      loopVersion: runnable.procedure.version,
      trigger: 'user',
    },
    launch: {
      ownerId: options.ownerId,
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.sampling ? { sampling: options.sampling } : {}),
    },
    inputs: { ...(scenario.input.inputs ?? {}), message: scenario.input.message },
    ...(scenario.budget ? { budget: scenario.budget } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onTrace
      ? {
        onTrace: (trace: NodeTrace) => options.onTrace!(trace, {
          runId: options.runId,
          agentSlug: scenario.agent,
          procedureId: runnable.procedure.id,
          procedureVersion: runnable.procedure.version,
        }),
      }
      : {}),
  });

  if (model) {
    await world.host.efforts?.record({
      runId: options.runId,
      ownerId: options.ownerId,
      agentSlug: scenario.agent,
      procedureId: runnable.procedure.id,
      procedureVersion: runnable.procedure.version,
      modelKey: model.key,
      modelLabel: model.label,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      rounds: result.counters.rounds,
      toolCalls: result.counters.toolCalls,
      totalTokens: result.counters.totalTokens,
      childRuns: result.counters.childRuns,
      longestReply: result.counters.longestReply,
      cappedAt: result.counters.cappedAt,
      steps: result.steps,
      wallClockMs: result.counters.elapsedMs,
      ask: scenario.input.message.slice(0, ASK_CHARS),
      limits: scenario.budget ?? {},
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
  }

  const finished = result.finishedBy ? result.outputs[result.finishedBy] : undefined;
  const answer = typeof finished?.result === 'string' ? finished.result : '';

  const observed: Observed = {
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    calls: world.calls(),
    tasks: world.tasks(),
    counters: { rounds: result.counters.rounds, toolCalls: result.counters.toolCalls, totalTokens: result.counters.totalTokens },
    answer,
    saved: world.saved(),
  };

  const checks = await scoreScenario(scenario.expect, observed, {
    tools: options.tools,
    reported: async (says, said) => {
      const decided = await runProcedure({
        procedure: askedWhetherReported(says, said),
        catalogue,
        groups: BUILT_IN_GROUPS,
        executor,
        identity: { runId: `${options.runId}-reported`, depth: 0, agentId: scenario.agent, loopId: DECIDE.id, loopVersion: DECIDE.version, trigger: 'agent' },
        launch: { ownerId: options.ownerId, ...(options.modelId ? { modelId: options.modelId } : {}) },
        inputs: {},
      });
      return readDecision(decided.reason ?? '') === 'yes';
    },
  });

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    runId: options.runId,
    procedure: { id: runnable.procedure.id, version: runnable.procedure.version },
    passed: checks.length > 0 && checks.every((check) => check.passed),
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    answer,
    checks,
    calls: observed.calls.map((call) => ({ name: call.name, ok: call.ok, digest: call.digest.slice(0, 500) })),
    counters: observed.counters,
    tasks: observed.tasks.map((task: Task) => ({ id: task.id, title: task.title, status: task.status, ...(task.evidence ? { evidence: task.evidence } : {}) })),
    durationMs: Date.now() - startedAt,
  };
}

