import { v4 as uuidv4 } from 'uuid';
import type { NodeExecutor } from '@koala/agent-engine/procedure';
import type { ToolDefinition } from '@koala/agent-engine';
import type { SamplingConfig } from '@koala/harness-types';
import { BUILDER_CASES, caseProblems, checkSuite, type EvalCase, type Provocation, type SuiteProblem } from '../eval/cases.js';
import { byTool, type CaseOutcome, type ToolScore } from '../eval/score.js';
import { reliability, type Reliability } from '../eval/run.js';
import { hashOf, runAttempt } from '../eval/level1/attempt.js';
import { ASK_CHARS, type RunEffort } from '@koala/agent-engine/procedure';
import { compareRuns, type CaseResult, type RunComparison } from '../eval/level1/compare.js';
import type { EvalCollection, EvalRecord } from '../lib/eval-run.js';

export type Level1RunState = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface Level1Run extends EvalRecord {
  state: Level1RunState;
  startedAt: string;
  finishedAt?: string | undefined;
  repeats: number;
  modelId?: string | undefined;
  modelLabel?: string | undefined;
  sampling?: SamplingConfig | undefined;
  maxTokens?: number | undefined;
  toolCatalogueHash: string;
  cases: string[];
  finished: number;
  running?: string | undefined;
  results: CaseResult[];
  error?: string | undefined;
}

export interface Level1RunSummary {
  reliability: Reliability;
  tools: ToolScore[];
}

export interface StoredPrompt extends EvalRecord {
  text: string;
}

export type StoredCase = EvalCase & EvalRecord;

export interface EvalRecordStore {
  getEvalRecords<T extends EvalRecord>(collection: EvalCollection, ownerId: string, limit?: number): Promise<T[]>;
  getEvalRecordsInState<T extends EvalRecord>(collection: EvalCollection, state: string): Promise<T[]>;
  getEvalRecord<T extends EvalRecord>(collection: EvalCollection, ownerId: string, id: string): Promise<T | null>;
  saveEvalRecord<T extends EvalRecord>(collection: EvalCollection, record: T): Promise<void>;
  deleteEvalRecord(collection: EvalCollection, ownerId: string, id: string): Promise<void>;
}

export interface Level1ServiceOptions {
  executor: NodeExecutor;
  tools: (ownerId: string) => Promise<ToolDefinition[]>;
  agents: (ownerId: string) => Promise<string[]>;
  store: EvalRecordStore;
  provokedByScenarios?: ((ownerId: string) => Promise<Provocation[]>) | undefined;
  efforts?: ((effort: RunEffort) => Promise<void>) | undefined;
  builtIn?: readonly EvalCase[] | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

export type SaveCaseOutcome = { saved: true; case: StoredCase } | { saved: false; problems: string[] };

export const DEFAULT_REPEATS = 5;

const outcomeOf = (result: CaseResult): CaseOutcome => ({
  name: result.name,
  category: result.category,
  attempts: result.attempts.length,
  passed: result.attempts.filter((attempt) => attempt.passed).length,
  complaints: result.attempts.flatMap((attempt) => (attempt.complaint ? [attempt.complaint] : [])),
});

export function summariseLevel1(run: Level1Run): Level1RunSummary {
  const outcomes = run.results.map(outcomeOf);
  return {
    reliability: reliability(outcomes),
    tools: byTool(run.results.map((result) => ({ name: result.name, expect: { tool: result.expects } })), outcomes),
  };
}

export class Level1Service {
  private readonly aborts = new Map<string, AbortController>();
  private readonly options: Level1ServiceOptions;

  constructor(options: Level1ServiceOptions) {
    this.options = options;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  private get builtIn(): readonly EvalCase[] {
    return this.options.builtIn ?? BUILDER_CASES;
  }

  async recover(): Promise<number> {
    const stranded = await this.options.store.getEvalRecordsInState<Level1Run>('evalLevel1Runs', 'running');
    for (const run of stranded) {
      await this.options.store.saveEvalRecord('evalLevel1Runs', {
        ...run,
        state: 'interrupted',
        finishedAt: this.now(),
        error: 'the server restarted while this ran, so it stopped here',
      });
    }
    return stranded.length;
  }

  async cases(ownerId: string): Promise<(EvalCase & { mine: boolean })[]> {
    const mine = await this.options.store.getEvalRecords<StoredCase>('evalCases', ownerId, 1000);
    const byName = new Map<string, EvalCase & { mine: boolean }>();
    for (const entry of this.builtIn) byName.set(entry.name, { ...entry, mine: false });
    for (const { id: _id, ...entry } of mine) byName.set(entry.name, { ...entry, mine: true });
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveCase(ownerId: string, input: unknown): Promise<SaveCaseOutcome> {
    const [tools, agents] = await Promise.all([this.options.tools(ownerId), this.options.agents(ownerId)]);
    const problems = caseProblems(input, { agents: new Set(agents), tools });
    if (problems.length > 0) return { saved: false, problems };
    const entry = input as EvalCase;
    const stored: StoredCase = {
      id: entry.name,
      ownerId,
      name: entry.name,
      category: entry.category,
      agent: entry.agent,
      say: entry.say,
      expect: entry.expect,
      ...(entry.repeats !== undefined ? { repeats: entry.repeats } : {}),
      ...(entry.provokes ? { provokes: entry.provokes } : {}),
      updatedAt: this.now(),
    };
    await this.options.store.saveEvalRecord('evalCases', stored);
    return { saved: true, case: stored };
  }

  async deleteCase(ownerId: string, name: string): Promise<boolean> {
    const found = await this.options.store.getEvalRecord<StoredCase>('evalCases', ownerId, name);
    if (!found) return false;
    await this.options.store.deleteEvalRecord('evalCases', ownerId, name);
    return true;
  }

  async coverage(ownerId: string): Promise<SuiteProblem[]> {
    const [tools, cases, provoked] = await Promise.all([
      this.options.tools(ownerId),
      this.cases(ownerId),
      this.options.provokedByScenarios?.(ownerId) ?? Promise.resolve([]),
    ]);
    return checkSuite(tools, cases, provoked);
  }

  async list(ownerId: string): Promise<Level1Run[]> {
    return this.options.store.getEvalRecords<Level1Run>('evalLevel1Runs', ownerId, 100);
  }

  async get(ownerId: string, id: string): Promise<Level1Run | undefined> {
    return (await this.options.store.getEvalRecord<Level1Run>('evalLevel1Runs', ownerId, id)) ?? undefined;
  }

  async prompt(ownerId: string, hash: string): Promise<string | undefined> {
    return (await this.options.store.getEvalRecord<StoredPrompt>('evalPrompts', ownerId, hash))?.text;
  }

  async compare(ownerId: string, before: string, after: string): Promise<RunComparison | undefined> {
    const [a, b] = await Promise.all([this.get(ownerId, before), this.get(ownerId, after)]);
    return a && b ? compareRuns(a, b) : undefined;
  }

  cancel(ownerId: string, id: string): boolean {
    const abort = this.aborts.get(`${ownerId}:${id}`);
    if (!abort) return false;
    abort.abort('the run was cancelled');
    return true;
  }

  async start(input: {
    ownerId: string;
    repeats?: number | undefined;
    only?: readonly string[] | undefined;
    modelId?: string | undefined;
    modelLabel?: string | undefined;
    sampling?: SamplingConfig | undefined;
    maxTokens?: number | undefined;
  }): Promise<Level1Run | { unknown: string[] }> {
    const all = await this.cases(input.ownerId);
    const unknown = (input.only ?? []).filter((name) => !all.some((entry) => entry.name === name));
    if (unknown.length > 0) return { unknown };
    const chosen = input.only?.length ? all.filter((entry) => input.only!.includes(entry.name)) : all;
    const tools = await this.options.tools(input.ownerId);

    const run: Level1Run = {
      id: (this.options.newId ?? uuidv4)(),
      ownerId: input.ownerId,
      state: 'running',
      startedAt: this.now(),
      repeats: input.repeats ?? DEFAULT_REPEATS,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.modelLabel ? { modelLabel: input.modelLabel } : {}),
      ...(input.sampling ? { sampling: input.sampling } : {}),
      ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
      toolCatalogueHash: hashOf(JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name)))),
      cases: chosen.map((entry) => entry.name),
      finished: 0,
      results: [],
    };
    await this.options.store.saveEvalRecord('evalLevel1Runs', run);

    const abort = new AbortController();
    this.aborts.set(`${run.ownerId}:${run.id}`, abort);
    void this.drive(run, chosen, abort.signal).finally(() => this.aborts.delete(`${run.ownerId}:${run.id}`));
    return run;
  }

  private async recordEffort(run: Level1Run, entry: EvalCase, attempt: number, outcome: Awaited<ReturnType<typeof runAttempt>>): Promise<void> {
    if (!this.options.efforts || !outcome.model) return;
    const { record } = outcome;

    await this.options.efforts({
      runId: `eval-${run.id}-${entry.name}-${attempt}`,
      ownerId: run.ownerId,
      agentSlug: entry.agent,
      procedureId: 'level-1-attempt',
      procedureVersion: '1',
      modelKey: outcome.model.key,
      modelLabel: outcome.model.label,
      outcome: record.error ? 'failed' : 'ok',
      rounds: 1,
      toolCalls: record.toolCalls.length,
      totalTokens: record.totalTokens,
      childRuns: 0,
      longestReply: record.completionTokens,
      cappedAt: outcome.cappedAt ?? 0,
      steps: 1,
      wallClockMs: record.latencyMs,
      ask: entry.say.slice(0, ASK_CHARS),
      limits: {},
      finishedAt: this.now(),
    });
  }

  private async drive(run: Level1Run, chosen: readonly EvalCase[], signal: AbortSignal): Promise<void> {
    const saved = new Set<string>();
    try {
      for (const entry of chosen) {
        if (signal.aborted) break;
        run.running = entry.name;
        const result: CaseResult = { name: entry.name, category: entry.category, agent: entry.agent, expects: entry.expect.tool, attempts: [] };
        run.results.push(result);
        await this.options.store.saveEvalRecord('evalLevel1Runs', run);

        const repeats = entry.repeats ?? run.repeats;
        for (let attempt = 0; attempt < repeats && !signal.aborted; attempt += 1) {
          try {
            const outcome = await runAttempt(entry, {
              executor: this.options.executor,
              tools: this.options.tools,
              ownerId: run.ownerId,
              runId: `eval-${run.id}`,
              attempt,
              ...(run.modelId ? { modelId: run.modelId } : {}),
              ...(run.sampling ? { sampling: run.sampling } : {}),
              ...(run.maxTokens ? { maxTokens: run.maxTokens } : {}),
              signal,
            });
            const { record, system } = outcome;
            if (signal.aborted && !record.toolCalls.length && !record.content) break;
            result.attempts.push(record);
            await this.recordEffort(run, entry, attempt, outcome).catch(() => undefined);
            if (system !== undefined && record.systemHash && !saved.has(record.systemHash)) {
              saved.add(record.systemHash);
              await this.options.store.saveEvalRecord<StoredPrompt>('evalPrompts', { id: record.systemHash, ownerId: run.ownerId, text: system });
            }
          } catch (err) {
            result.attempts.push({
              attempt, passed: false, error: (err as Error).message, complaint: `the attempt broke: ${(err as Error).message}`,
              toolsOffered: [], content: '', thinking: '', toolCalls: [], promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0,
            });
          }
          await this.options.store.saveEvalRecord('evalLevel1Runs', run);
        }
        if (!signal.aborted) run.finished += 1;
      }
      run.state = signal.aborted ? 'cancelled' : 'done';
    } catch (err) {
      run.state = 'failed';
      run.error = (err as Error).message;
    } finally {
      delete run.running;
      run.finishedAt = this.now();
      await this.options.store.saveEvalRecord('evalLevel1Runs', run);
    }
  }
}
