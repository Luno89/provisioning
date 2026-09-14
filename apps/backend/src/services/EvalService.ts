import { v4 as uuidv4 } from 'uuid';
import { runSuite, type EvalPorts } from '../engine/eval/run.js';
import { checkSuite, type EvalCase, type SuiteProblem } from '../engine/eval/cases.js';
import { reliability, type Reliability } from '../engine/eval/run.js';
import type { CaseOutcome } from '../engine/eval/score.js';
import type { ToolDefinition } from '../engine/catalogue.js';

export type EvalRunState = 'running' | 'done' | 'failed' | 'cancelled';

export interface EvalRun {
  id: string;
  ownerId: string;
  state: EvalRunState;
  startedAt: string;
  finishedAt?: string | undefined;
  repeats: number;
  modelId?: string | undefined;
  modelLabel?: string | undefined;
  total: number;
  finished: number;
  running?: string | undefined;
  outcomes: CaseOutcome[];
  reliability?: Reliability | undefined;
  error?: string | undefined;
}

export interface EvalServiceOptions {
  ports: EvalPorts;
  cases: readonly EvalCase[];
  catalogue: readonly ToolDefinition[];
  now?: (() => string) | undefined;
  keep?: number | undefined;
}

export const DEFAULT_KEEP = 20;

export class EvalService {
  private readonly runs = new Map<string, EvalRun>();

  private readonly cancelled = new Set<string>();

  constructor(private readonly options: EvalServiceOptions) {}

  private get now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  cases(): readonly EvalCase[] {
    return this.options.cases;
  }

  coverage(): SuiteProblem[] {
    return checkSuite(this.options.catalogue, this.options.cases);
  }

  get(ownerId: string, id: string): EvalRun | undefined {
    const run = this.runs.get(id);
    return run && run.ownerId === ownerId ? run : undefined;
  }

  list(ownerId: string): EvalRun[] {
    return [...this.runs.values()]
      .filter((run) => run.ownerId === ownerId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  cancel(ownerId: string, id: string): boolean {
    const run = this.get(ownerId, id);
    if (!run || run.state !== 'running') return false;

    this.cancelled.add(id);
    return true;
  }

  start(input: {
    ownerId: string;
    repeats?: number | undefined;
    only?: string[] | undefined;
    modelId?: string | undefined;
    modelLabel?: string | undefined;
  }): EvalRun {
    const chosen = input.only?.length
      ? this.options.cases.filter((entry) => input.only!.includes(entry.name))
      : [...this.options.cases];

    const run: EvalRun = {
      id: uuidv4(),
      ownerId: input.ownerId,
      state: 'running',
      startedAt: this.now,
      repeats: input.repeats ?? 5,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.modelLabel ? { modelLabel: input.modelLabel } : {}),
      total: chosen.length,
      finished: 0,
      outcomes: [],
    };

    this.runs.set(run.id, run);
    this.prune();
    void this.drive(run, chosen);

    return run;
  }

  private async drive(run: EvalRun, chosen: readonly EvalCase[]): Promise<void> {
    try {
      for (const entry of chosen) {
        if (this.cancelled.has(run.id)) {
          run.state = 'cancelled';
          run.finishedAt = this.now;
          this.cancelled.delete(run.id);
          return;
        }

        run.running = entry.name;
        const [outcome] = await runSuite([entry], {
          ports: this.options.ports,
          ownerId: run.ownerId,
          repeats: run.repeats,
          ...(run.modelId ? { modelId: run.modelId } : {}),
        });

        if (outcome) run.outcomes.push(outcome);
        run.finished += 1;
      }

      run.state = 'done';
    } catch (err) {
      run.state = 'failed';
      run.error = (err as Error).message;
    } finally {
      delete run.running;
      run.finishedAt = this.now;
      run.reliability = reliability(run.outcomes);
    }
  }

  private prune(): void {
    const keep = this.options.keep ?? DEFAULT_KEEP;
    const settled = [...this.runs.values()]
      .filter((run) => run.state !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    for (const run of settled.slice(0, Math.max(0, settled.length - keep))) {
      this.runs.delete(run.id);
    }
  }
}
