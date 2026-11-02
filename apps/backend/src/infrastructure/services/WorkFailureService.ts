import { ignore } from '@koala/engine-core/failures';
import type { RunningRecords, RunningWorkflow } from '../lib/running.js';
import {
  FAILURE_SHOWN_ON_RECORD, KEPT_FOR_MS, describeFailure, runFailureId, shownFailures, temporalFailureReason, workflowFailureId,
  type WorkFailure,
} from '../lib/work-failures.js';

export interface FailedWorkflow {
  workflowId: string;
  temporalRunId: string;
  type: string;
  ownerId?: string | undefined;
  parent?: string | undefined;
  startedAt: string;
  failedAt: string;
  memo?: Record<string, unknown> | undefined;
  message?: string | undefined;
  cause?: string | undefined;
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
  revoked?: { reason: string; handover?: string | undefined } | undefined;
}

const NO_RECORDS: RunningRecords = { trees: [], projects: [], conversations: [], checkRuns: [], releases: [], agentName: () => undefined };

export class WorkFailureService {
  private readonly now: () => Date;

  constructor(private readonly deps: WorkFailureDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private recordsOf(ownerId: string): Promise<RunningRecords> {
    return this.deps.records(ownerId).catch(() => NO_RECORDS);
  }

  private async record(failure: WorkFailure): Promise<void> {
    const known = (await this.deps.store.getWorkFailures(failure.ownerId)).some((entry) => entry.id === failure.id);
    if (known) return;
    await this.deps.store.addWorkFailure(failure);
    await this.deps.store.pruneWorkFailures(new Date(this.now().getTime() - KEPT_FOR_MS).toISOString());
    this.deps.onFailure?.(failure);
  }

  async runEnded(event: RunEnded): Promise<WorkFailure | undefined> {
    if (event.depth !== 0 || (event.outcome !== 'failed' && !event.revoked)) return undefined;
    if (!(await this.deps.isPerson(event.ownerId))) return undefined;
    const workflow = await this.deps.workflows.describeRun(event.runId).catch(ignore('a run Temporal no longer describes is recorded from what the event says'))
      ?? { workflowId: event.runId, type: 'AgentRunWorkflow', startedAt: this.now().toISOString() };
    const failure = describeFailure(workflow, await this.recordsOf(event.ownerId), {
      id: runFailureId(event.runId),
      ownerId: event.ownerId,
      reason: event.revoked?.reason ?? event.reason ?? 'it failed',
      failedAt: this.now().toISOString(),
    });
    if (event.revoked?.handover) failure.handover = event.revoked.handover;
    await this.record(failure);
    return failure;
  }

  async workflowFailed(failed: FailedWorkflow): Promise<WorkFailure | undefined> {
    if (failed.parent || FAILURE_SHOWN_ON_RECORD.includes(failed.type)) return undefined;
    if (!failed.ownerId || !(await this.deps.isPerson(failed.ownerId))) return undefined;
    const failure = describeFailure(
      { workflowId: failed.workflowId, type: failed.type, startedAt: failed.startedAt, ...(failed.memo ? { memo: failed.memo } : {}) },
      await this.recordsOf(failed.ownerId),
      {
        id: workflowFailureId(failed.workflowId, failed.temporalRunId),
        ownerId: failed.ownerId,
        reason: temporalFailureReason({ message: failed.message, cause: failed.cause ? { message: failed.cause } : undefined }, 'FAILED'),
        failedAt: failed.failedAt,
      },
    );
    await this.record(failure);
    return failure;
  }

  async shown(ownerId: string): Promise<WorkFailure[]> {
    return shownFailures(await this.deps.store.getWorkFailures(ownerId), this.now().getTime());
  }

  async clear(ownerId: string, ids: readonly string[] | 'all'): Promise<number> {
    return this.deps.store.clearWorkFailures(ownerId, ids, this.now().toISOString());
  }
}
