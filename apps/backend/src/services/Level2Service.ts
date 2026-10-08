import { v4 as uuidv4 } from 'uuid';
import type { ToolDefinition } from '@koala/agent-engine';
import type { SamplingConfig } from '@koala/harness-types';
import { BUILT_IN_SCENARIOS } from '../eval/level2/scenarios.js';
import { scenarioProblems, type Scenario } from '../eval/level2/scenario.js';
import type { ScenarioResult } from '../eval/level2/results.js';
import type { Client } from '@temporalio/client';
import type { CheckRunInput, CheckRunOutcome } from '../workflows/CheckRunWorkflow.js';
import type { EvalRecord, EvalRecordStore } from '../lib/eval-run.js';
import { regressionsIn, type BenchTrigger } from '../lib/bench.js';
import type { ScenarioProposal } from '../lib/scenario-proposals.js';
import { checkCoverage, type CoverageGap } from '../lib/check-coverage.js';
import { compareCheckRuns, type CheckRunComparison } from '../lib/check-compare.js';
import type { Procedure } from '@koala/agent-engine/procedure';
import { turnProcedure } from '../lib/turn-check.js';
import { stepProcedure } from '../lib/step-check.js';
import { platformCatalogue, platformGroups } from '../extensions/installed.js';
import { startedFor } from '../lib/workflow-owner.js';

export type Level2RunState = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface Level2Run extends EvalRecord {
  state: Level2RunState;
  startedAt: string;
  finishedAt?: string | undefined;
  modelId?: string | undefined;
  modelLabel?: string | undefined;
  sampling?: SamplingConfig | undefined;
  scenarios: string[];
  finished: number;
  running?: string | undefined;
  results: ScenarioResult[];
  error?: string | undefined;
  trigger?: BenchTrigger | undefined;
  regressions?: string[] | undefined;
  trialPractice?: string | undefined;
  promptOverride?: { agent: string; prompt: string } | undefined;
  agents?: Record<string, string> | undefined;
}

export type StoredScenario = Scenario & EvalRecord;

export const checkRunWorkflowId = (checkRunId: string): string => `check-run-${checkRunId}`;

export interface CheckRunner {
  start(workflowId: string, input: CheckRunInput): Promise<void>;
  cancel(workflowId: string): Promise<boolean>;
  outcome(workflowId: string): Promise<CheckRunOutcome | { failed: string } | { missing: true }>;
}

const innermost = (err: unknown): string | undefined => {
  let reason: string | undefined;
  for (let at = err as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
    if (typeof at.message === 'string' && at.message) reason = at.message;
  }
  return reason;
};

export function temporalCheckRunner(client: () => Client | undefined | null, taskQueue: string): CheckRunner {
  const connected = (): Client => {
    const temporal = client();
    if (!temporal) throw new Error('Temporal is not reachable');
    return temporal;
  };
  return {
    async start(workflowId, input) {
      await connected().workflow.start('CheckRunWorkflow', { workflowId, taskQueue, args: [input], ...startedFor(input.person) });
    },
    async cancel(workflowId) {
      return connected().workflow.getHandle(workflowId).signal('cancelCheck').then(() => true, () => false);
    },
    async outcome(workflowId) {
      try {
        return await connected().workflow.getHandle(workflowId).result() as CheckRunOutcome;
      } catch (err) {
        const reason = innermost(err) ?? 'the checks failed';
        return /not\s*found/i.test(reason) ? { missing: true } : { failed: reason };
      }
    },
  };
}

export interface Level2ServiceOptions {
  checks: CheckRunner;
  tools: (ownerId: string) => Promise<ToolDefinition[]>;
  agents: (ownerId: string) => Promise<string[]>;
  procedures: (ownerId: string) => Promise<string[]>;
  store: EvalRecordStore;
  builtIn?: readonly Scenario[] | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
  onFinished?: ((run: Level2Run) => Promise<void>) | undefined;
  fingerprints?: ((ownerId: string, agents: readonly string[]) => Promise<Record<string, string>>) | undefined;
}

export type SaveScenarioOutcome = { saved: true; scenario: StoredScenario } | { saved: false; problems: string[] };

export class Level2Service {
  private readonly options: Level2ServiceOptions;

  constructor(options: Level2ServiceOptions) {
    this.options = options;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  async recover(): Promise<number> {
    const running = await this.options.store.getEvalRecordsInState<Level2Run>('evalScenarioRuns', 'running');
    for (const run of running) void this.settle(run.ownerId, run.id);
    return running.length;
  }

  async scenarios(ownerId: string): Promise<(Scenario & { mine: boolean })[]> {
    const mine = await this.options.store.getEvalRecords<StoredScenario>('evalScenarios', ownerId, 500);
    const byId = new Map<string, Scenario & { mine: boolean }>();
    for (const scenario of this.options.builtIn ?? BUILT_IN_SCENARIOS) byId.set(scenario.id, { ...scenario, mine: false });
    for (const scenario of mine) byId.set(scenario.id, { ...scenario, mine: true });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async coverage(ownerId: string): Promise<CoverageGap[]> {
    const [tools, checks] = await Promise.all([this.options.tools(ownerId), this.scenarios(ownerId)]);
    return checkCoverage(tools, checks);
  }

  async proposals(ownerId: string): Promise<ScenarioProposal[]> {
    const all = await this.options.store.getEvalRecords<ScenarioProposal>('evalScenarioProposals', ownerId, 1000);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async acceptProposal(ownerId: string, id: string, edited?: unknown): Promise<SaveScenarioOutcome | { missing: true }> {
    const proposal = await this.options.store.getEvalRecord<ScenarioProposal>('evalScenarioProposals', ownerId, id);
    if (!proposal || proposal.status !== 'proposed') return { missing: true };
    const saved = await this.saveScenario(ownerId, edited ?? proposal.scenario);
    if (saved.saved) await this.options.store.saveEvalRecord('evalScenarioProposals', { ...proposal, status: 'accepted', decidedAt: this.now() });
    return saved;
  }

  async dismissProposal(ownerId: string, id: string): Promise<boolean> {
    const proposal = await this.options.store.getEvalRecord<ScenarioProposal>('evalScenarioProposals', ownerId, id);
    if (!proposal || proposal.status !== 'proposed') return false;
    await this.options.store.saveEvalRecord('evalScenarioProposals', { ...proposal, status: 'dismissed', decidedAt: this.now() });
    return true;
  }

  async saveScenario(ownerId: string, input: unknown): Promise<SaveScenarioOutcome> {
    const [tools, agents, procedures] = await Promise.all([
      this.options.tools(ownerId),
      this.options.agents(ownerId),
      this.options.procedures(ownerId),
    ]);
    const problems = scenarioProblems(input, { agents: new Set(agents), procedures: new Set(procedures), tools });
    if (problems.length > 0) return { saved: false, problems };
    const scenario = input as Scenario;
    const stored: StoredScenario = { ...scenario, ownerId, updatedAt: this.now() };
    await this.options.store.saveEvalRecord('evalScenarios', stored);
    return { saved: true, scenario: stored };
  }

  async deleteScenario(ownerId: string, id: string): Promise<boolean> {
    const found = await this.options.store.getEvalRecord<StoredScenario>('evalScenarios', ownerId, id);
    if (!found) return false;
    await this.options.store.deleteEvalRecord('evalScenarios', ownerId, id);
    return true;
  }

  async start(input: {
    ownerId: string;
    only?: readonly string[] | undefined;
    modelId?: string | undefined;
    modelLabel?: string | undefined;
    sampling?: SamplingConfig | undefined;
    trigger?: BenchTrigger | undefined;
    trialPractice?: string | undefined;
    promptOverride?: { agent: string; prompt: string } | undefined;
  }): Promise<Level2Run | { unknown: string[] }> {
    const all = await this.scenarios(input.ownerId);
    const unknown = (input.only ?? []).filter((id) => !all.some((scenario) => scenario.id === id));
    if (unknown.length > 0) return { unknown };
    const chosen = input.only?.length ? all.filter((scenario) => input.only!.includes(scenario.id)) : all;

    const agents = await this.options.fingerprints?.(input.ownerId, [...new Set(chosen.map((scenario) => scenario.agent))]).catch(() => undefined);
    const run: Level2Run = {
      ...(agents ? { agents } : {}),
      id: (this.options.newId ?? uuidv4)(),
      ownerId: input.ownerId,
      state: 'running',
      startedAt: this.now(),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.modelLabel ? { modelLabel: input.modelLabel } : {}),
      ...(input.sampling ? { sampling: input.sampling } : {}),
      scenarios: chosen.map((scenario) => scenario.id),
      finished: 0,
      results: [],
      trigger: input.trigger ?? { kind: 'manual' },
      ...(input.trialPractice ? { trialPractice: input.trialPractice } : {}),
      ...(input.promptOverride ? { promptOverride: input.promptOverride } : {}),
    };
    await this.options.store.saveEvalRecord('evalScenarioRuns', run);

    const contracts = new Set(chosen.flatMap((scenario) => [scenario.expect.provokes?.tool, scenario.expect.chooses?.tool].filter((tool): tool is string => Boolean(tool))));
    const tools = contracts.size > 0 ? (await this.options.tools(run.ownerId)).filter((tool) => contracts.has(tool.name)) : [];
    const chosenTemperature = input.sampling?.toolTurn?.temperature;
    const temperature = typeof chosenTemperature === 'number' ? chosenTemperature : undefined;
    try {
      await this.options.checks.start(checkRunWorkflowId(run.id), {
        checkRunId: run.id,
        person: run.ownerId,
        scenarios: chosen.map(({ mine: _mine, ...scenario }) => scenario),
        tools,
        ...(run.modelId ? { modelId: run.modelId } : {}),
        ...(temperature === undefined ? {} : { temperature }),
        ...(run.trialPractice ? { trialPractice: run.trialPractice } : {}),
        ...(run.promptOverride ? { promptOverride: run.promptOverride } : {}),
      });
    } catch (err) {
      const failed: Level2Run = { ...run, state: 'failed', finishedAt: this.now(), error: `the checks could not start: ${(err as Error).message}` };
      await this.options.store.saveEvalRecord('evalScenarioRuns', failed);
      return failed;
    }
    void this.settle(run.ownerId, run.id);
    return run;
  }

  private async settle(ownerId: string, id: string): Promise<void> {
    const outcome = await this.options.checks.outcome(checkRunWorkflowId(id)).catch((err: Error) => ({ failed: err.message }));
    const run = await this.get(ownerId, id);
    if (!run || run.state !== 'running') return;
    const { running: _running, ...rest } = run;
    const settled: Level2Run = 'missing' in outcome
      ? { ...rest, state: 'interrupted', error: 'the checks stopped being followed before they finished' }
      : 'failed' in outcome
        ? { ...rest, state: 'failed', error: outcome.failed }
        : { ...rest, state: outcome.cancelled ? 'cancelled' : 'done', results: outcome.results, finished: outcome.results.length };
    settled.finishedAt = this.now();
    settled.regressions = regressionsIn(settled.results, await this.earlier(settled));
    await this.options.store.saveEvalRecord('evalScenarioRuns', settled);
    await this.options.onFinished?.(settled).catch(() => undefined);
  }

  async list(ownerId: string): Promise<Level2Run[]> {
    return this.options.store.getEvalRecords<Level2Run>('evalScenarioRuns', ownerId, 100);
  }

  async get(ownerId: string, id: string): Promise<Level2Run | undefined> {
    return (await this.options.store.getEvalRecord<Level2Run>('evalScenarioRuns', ownerId, id)) ?? undefined;
  }

  async checkProcedure(ownerId: string, id: string): Promise<Procedure | undefined> {
    const check = (await this.scenarios(ownerId)).find((scenario) => scenario.id === id);
    if (check?.turn) return turnProcedure(platformCatalogue(), platformGroups());
    if (!check?.step) return undefined;
    const built = stepProcedure(check.id, check.step, platformCatalogue());
    return 'procedure' in built ? built.procedure : undefined;
  }

  async compare(ownerId: string, before: string, after: string): Promise<CheckRunComparison | undefined> {
    const [a, b, checks] = await Promise.all([this.get(ownerId, before), this.get(ownerId, after), this.scenarios(ownerId)]);
    if (!a || !b) return undefined;
    const chosen = new Map(checks.filter((check) => check.turn && check.expect.chooses).map((check) => [check.id, check.expect.chooses!.tool]));
    return compareCheckRuns(a, b, (id) => chosen.get(id));
  }

  async cancel(ownerId: string, id: string): Promise<boolean> {
    const run = await this.get(ownerId, id);
    if (!run || run.state !== 'running') return false;
    return this.options.checks.cancel(checkRunWorkflowId(id));
  }

  async earlier(run: Level2Run): Promise<Level2Run[]> {
    const runs = await this.options.store.getEvalRecords<Level2Run>('evalScenarioRuns', run.ownerId, 100).catch(() => []);
    return runs
      .filter((other) => other.id !== run.id && other.startedAt < run.startedAt && other.state === 'done')
      .filter((other) => other.trigger?.kind !== 'practice' && other.trigger?.kind !== 'prompt-change')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
