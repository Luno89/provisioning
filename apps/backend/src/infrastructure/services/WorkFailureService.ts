import type { RunningRecords, RunningWorkflow } from '../lib/running.js';
import {
  FAILURE_SHOWN_ON_RECORD, KEPT_FOR_MS, describeFailure, runFailureId, shownFailures, temporalFailureReason, workflowFailureId,
  type WorkFailure,
} from '../lib/work-failures.js';

export interface ClosedWorkflow extends RunningWorkflow {
  temporalRunId: string;
  ownerId: string | undefined;
  closedAt: string;
  status: 'FAILED' | 'TIMED_OUT';
}

export interface WorkFailureDeps {
  onFailure?: ((failure: WorkFailure) => void) | undefined;
  store: {
    getWorkFailures(ownerId?: string): Promise<WorkFailure[]>;
    addWorkFailure(failure: WorkFailure): Promise<void>;
    clearWorkFailures(ownerId: string, ids: readonly string[] | 'all', at: string): Promise<number>;
    pruneWorkFailures(before: string): Promise<void>;
  };
  workflows: {
    closedSince(since: Date): Promise<ClosedWorkflow[]>;
    failureOf(workflowId: string, temporalRunId: string): Promise<{ message?: string | undefined; cause?: { message?: string | undefined } } | undefined>;
    describeRun(runId: string): Promise<RunningWorkflow | undefined>;
  };
  records(ownerId: string): Promise<RunningRecords>;
  isPerson(ownerId: string): Promise<boolean>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface RunEnded {
  ownerId: string;
  runId: string;
  outcome: string;
  reason?: string | undefined;
  depth: number;
}

export const POLL_MS = 30_000;

const NO_RECORDS: RunningRecords = { trees: [], projects: [], conversations: [], checkRuns: [], releases: [], agentName: () => undefined };
export const TEMPORAL_KEEPS_MS = 24 * 3_600_000;
export const VISIBILITY_LAG_MS = 5 * 60_000;

export class WorkFailureService {
  private readonly now: () => Date;
  private watermark: Date;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(private readonly deps: WorkFailureDeps) {
    this.now = deps.now ?? (() => new Date());
    this.watermark = new Date(this.now().getTime() - TEMPORAL_KEEPS_MS);
  }

  start(): void {
    if (this.timer) return;
    const tick = () => { void this.poll().catch((err: Error) => this.deps.log?.(`[failures] ${err.message}`)); };
    tick();
    this.timer = setInterval(tick, POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private recordsOf(ownerId: string): Promise<RunningRecords> {
    return this.deps.records(ownerId).catch(() => NO_RECORDS);
  }

  private async record(failure: WorkFailure): Promise<void> {
    const known = (await this.deps.store.getWorkFailures(failure.ownerId)).some((entry) => entry.id === failure.id);
    if (known) return;
    await this.deps.store.addWorkFailure(failure);
    this.deps.onFailure?.(failure);
  }

  async runEnded(event: RunEnded): Promise<WorkFailure | undefined> {
    if (event.depth !== 0 || event.outcome !== 'failed') return undefined;
    if (!(await this.deps.isPerson(event.ownerId))) return undefined;
    const workflow = await this.deps.workflows.describeRun(event.runId).catch(() => undefined)
      ?? { workflowId: event.runId, type: 'AgentRunWorkflow', startedAt: this.now().toISOString() };
    const failure = describeFailure(workflow, await this.recordsOf(event.ownerId), {
      id: runFailureId(event.runId),
      ownerId: event.ownerId,
      reason: event.reason ?? 'it failed',
      failedAt: this.now().toISOString(),
    });
    await this.record(failure);
    return failure;
  }

  async poll(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const since = this.watermark;
      const closed = await this.deps.workflows.closedSince(since);
      let added = 0;
      for (const workflow of closed) {
        if (workflow.parent || FAILURE_SHOWN_ON_RECORD.includes(workflow.type)) continue;
        if (!workflow.ownerId || !(await this.deps.isPerson(workflow.ownerId))) continue;
        const id = workflowFailureId(workflow.workflowId, workflow.temporalRunId);
        if ((await this.deps.store.getWorkFailures(workflow.ownerId)).some((entry) => entry.id === id)) continue;
        const cause = await this.deps.workflows.failureOf(workflow.workflowId, workflow.temporalRunId).catch(() => undefined);
        await this.record(describeFailure(workflow, await this.recordsOf(workflow.ownerId), {
          id,
          ownerId: workflow.ownerId,
          reason: temporalFailureReason(cause, workflow.status),
          failedAt: workflow.closedAt,
        }));
        added += 1;
      }
      this.watermark = new Date(this.now().getTime() - VISIBILITY_LAG_MS);
      await this.deps.store.pruneWorkFailures(new Date(this.now().getTime() - KEPT_FOR_MS).toISOString());
      return added;
    } finally {
      this.polling = false;
    }
  }

  async shown(ownerId: string): Promise<WorkFailure[]> {
    return shownFailures(await this.deps.store.getWorkFailures(ownerId), this.now().getTime());
  }

  async clear(ownerId: string, ids: readonly string[] | 'all'): Promise<number> {
    return this.deps.store.clearWorkFailures(ownerId, ids, this.now().toISOString());
  }
}
