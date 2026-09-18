import { v4 as uuidv4 } from 'uuid';
import type { NodeTrace } from '@koala/agent-engine/procedure';
import type { ToolDefinition } from '@koala/agent-engine';
import type { SamplingConfig } from '@koala/harness-types';
import { BUILT_IN_SCENARIOS } from '../eval/level2/scenarios.js';
import { scenarioProblems, type Scenario } from '../eval/level2/scenario.js';
import { runScenario, type ScenarioResult } from '../eval/level2/runner.js';
import { createWorld, type WorldOptions } from '../eval/level2/world.js';
import type { Provocation } from '../eval/cases.js';
import type { EvalRecord } from '../lib/eval-run.js';
import type { EvalRecordStore } from './Level1Service.js';
import type { StoredNodeTrace } from '../lib/run-traces.js';

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
}

export type StoredScenario = Scenario & EvalRecord;

export interface Level2ServiceOptions {
  world: Omit<WorldOptions, 'ownerId'>;
  tools: (ownerId: string) => Promise<ToolDefinition[]>;
  agents: (ownerId: string) => Promise<string[]>;
  procedures: (ownerId: string) => Promise<string[]>;
  store: EvalRecordStore;
  traces?: ((traces: StoredNodeTrace[]) => Promise<void>) | undefined;
  builtIn?: readonly Scenario[] | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

export type SaveScenarioOutcome = { saved: true; scenario: StoredScenario } | { saved: false; problems: string[] };

export class Level2Service {
  private readonly aborts = new Map<string, AbortController>();
  private readonly options: Level2ServiceOptions;

  constructor(options: Level2ServiceOptions) {
    this.options = options;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  async recover(): Promise<number> {
    const stranded = await this.options.store.getEvalRecordsInState<Level2Run>('evalScenarioRuns', 'running');
    for (const run of stranded) {
      await this.options.store.saveEvalRecord('evalScenarioRuns', {
        ...run,
        state: 'interrupted',
        finishedAt: this.now(),
        error: 'the server restarted while this ran, so it stopped here',
      });
    }
    return stranded.length;
  }

  async scenarios(ownerId: string): Promise<(Scenario & { mine: boolean })[]> {
    const mine = await this.options.store.getEvalRecords<StoredScenario>('evalScenarios', ownerId, 500);
    const byId = new Map<string, Scenario & { mine: boolean }>();
    for (const scenario of this.options.builtIn ?? BUILT_IN_SCENARIOS) byId.set(scenario.id, { ...scenario, mine: false });
    for (const scenario of mine) byId.set(scenario.id, { ...scenario, mine: true });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async provocations(ownerId: string): Promise<Provocation[]> {
    return (await this.scenarios(ownerId))
      .flatMap((scenario) => (scenario.expect.provokes ? [{ tool: scenario.expect.provokes.tool, when: scenario.expect.provokes.when }] : []));
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

  async list(ownerId: string): Promise<Level2Run[]> {
    return this.options.store.getEvalRecords<Level2Run>('evalScenarioRuns', ownerId, 100);
  }

  async get(ownerId: string, id: string): Promise<Level2Run | undefined> {
    return (await this.options.store.getEvalRecord<Level2Run>('evalScenarioRuns', ownerId, id)) ?? undefined;
  }

  cancel(ownerId: string, id: string): boolean {
    const abort = this.aborts.get(`${ownerId}:${id}`);
    if (!abort) return false;
    abort.abort('the run was cancelled');
    return true;
  }

  async start(input: {
    ownerId: string;
    only?: readonly string[] | undefined;
    modelId?: string | undefined;
    modelLabel?: string | undefined;
    sampling?: SamplingConfig | undefined;
  }): Promise<Level2Run | { unknown: string[] }> {
    const all = await this.scenarios(input.ownerId);
    const unknown = (input.only ?? []).filter((id) => !all.some((scenario) => scenario.id === id));
    if (unknown.length > 0) return { unknown };
    const chosen = input.only?.length ? all.filter((scenario) => input.only!.includes(scenario.id)) : all;

    const run: Level2Run = {
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
    };
    await this.options.store.saveEvalRecord('evalScenarioRuns', run);

    const abort = new AbortController();
    this.aborts.set(`${run.ownerId}:${run.id}`, abort);
    void this.drive(run, chosen, abort.signal).finally(() => this.aborts.delete(`${run.ownerId}:${run.id}`));
    return run;
  }

  private async drive(run: Level2Run, chosen: readonly Scenario[], signal: AbortSignal): Promise<void> {
    const tools = await this.options.tools(run.ownerId);
    try {
      for (const scenario of chosen) {
        if (signal.aborted) break;
        run.running = scenario.id;
        await this.options.store.saveEvalRecord('evalScenarioRuns', run);

        const world = createWorld(scenario, { ...this.options.world, ownerId: run.ownerId });
        const pending: StoredNodeTrace[] = [];
        try {
          const result = await runScenario(scenario, {
            world,
            ownerId: run.ownerId,
            runId: `eval2-${run.id}-${scenario.id}`,
            tools,
            ...(run.modelId ? { modelId: run.modelId } : {}),
            ...(run.sampling ? { sampling: run.sampling } : {}),
            signal,
            ...(this.options.traces
              ? {
                onTrace: (trace: NodeTrace, identity) => {
                  pending.push({ ...trace, ownerId: run.ownerId, runId: identity.runId, agentSlug: identity.agentSlug, procedureId: identity.procedureId, procedureVersion: identity.procedureVersion });
                },
              }
              : {}),
          });
          run.results.push(result);
        } catch (err) {
          run.results.push({
            scenarioId: scenario.id,
            name: scenario.name,
            runId: `eval2-${run.id}-${scenario.id}`,
            procedure: { id: scenario.procedure.id, version: scenario.procedure.version ?? '' },
            passed: false,
            outcome: 'failed',
            answer: '',
            checks: [],
            calls: [],
            counters: { rounds: 0, toolCalls: 0, totalTokens: 0 },
            tasks: [],
            durationMs: 0,
            error: (err as Error).message,
          });
        } finally {
          await world.release();
          if (pending.length > 0) await this.options.traces?.(pending).catch(() => undefined);
        }

        if (!signal.aborted) run.finished += 1;
        await this.options.store.saveEvalRecord('evalScenarioRuns', run);
      }
      run.state = signal.aborted ? 'cancelled' : 'done';
    } catch (err) {
      run.state = 'failed';
      run.error = (err as Error).message;
    } finally {
      delete run.running;
      run.finishedAt = this.now();
      await this.options.store.saveEvalRecord('evalScenarioRuns', run);
    }
  }
}
