import type { WorkflowClient } from '@temporalio/client';
import { EngineUnavailableError, type StartRunRequest, type StartedRun } from './registries/run-starter.js';
import { groveRunWorkflowId, type AgentRunOutcome, type GroveRunResult } from './temporal/contracts.js';
import { failureReason } from '../lib/temporal-failure.js';
import type { GroveRunLauncher } from '../services/GroveRunService.js';
import type { GroveRunStatus } from '../services/TemporalBridge.js';

export interface GroveLauncherDeps {
  runs: { start(request: StartRunRequest): Promise<StartedRun> };
  client: () => Pick<WorkflowClient, 'getHandle'> | undefined;
  agentFor: (ownerId: string, treeId: string) => Promise<string>;
  leafRun: (leafId: string) => Promise<string | undefined>;
  hidden?: ((ownerId: string) => Promise<{ agents: ReadonlySet<string> }>) | undefined;
}

const notFound = (err: unknown): boolean => /not\s*found/i.test(String((err as Error)?.message ?? err));

export function resultOf(treeId: string, outcome: AgentRunOutcome): { result: GroveRunResult } | { reason: string } {
  if (outcome.outcome === 'ok') {
    const result = outcome.outputs as Partial<GroveRunResult>;
    return { result: { treeId, outcome: 'quiet', awaitingReview: [], awaitingApproval: [], ...result } as GroveRunResult };
  }
  if (outcome.outcome === 'interrupted') return { result: { treeId, outcome: 'stopped', awaitingReview: [], awaitingApproval: [] } };
  return { reason: outcome.reason ?? `the run ended ${outcome.outcome}` };
}

export function createGroveLauncher(deps: GroveLauncherDeps): GroveRunLauncher {
  const signal = async (workflowId: string): Promise<boolean> => {
    const client = deps.client();
    if (!client) return false;
    const handle = client.getHandle(workflowId);
    try {
      if ((await handle.describe()).status.name !== 'RUNNING') return false;
    } catch (err) {
      if (notFound(err)) return false;
      throw err;
    }
    await handle.signal('cancelRun');
    return true;
  };

  return {
    async startGroveRun(ownerId, treeId) {
      if (!deps.client()) return { started: false, reason: 'unavailable' };
      const workflowId = groveRunWorkflowId(treeId);
      const agentSlug = await deps.agentFor(ownerId, treeId);
      if ((await deps.hidden?.(ownerId))?.agents.has(agentSlug)) return { started: false, reason: 'switched-off' };
      try {
        await deps.runs.start({
          ownerId,
          agentSlug,
          message: 'Grow the tree.',
          runId: workflowId,
          bound: { treeId },
        });
        return { started: true, workflowId };
      } catch (err) {
        if (err instanceof EngineUnavailableError) return { started: false, reason: 'unavailable' };
        if (/already started|AlreadyStarted/i.test(`${(err as Error)?.name} ${(err as Error)?.message}`)) return { started: false, reason: 'running' };
        throw err;
      }
    },

    async groveRunStatus(treeId) {
      const client = deps.client();
      if (!client) return { state: 'unavailable' };
      const handle = client.getHandle(groveRunWorkflowId(treeId));
      let described;
      try {
        described = await handle.describe();
      } catch (err) {
        if (notFound(err)) return { state: 'none' };
        throw err;
      }
      const startedAt = described.startTime.toISOString();
      const closedAt = described.closeTime?.toISOString();
      const status = described.status.name;
      if (status === 'RUNNING') return { state: 'running', startedAt };
      if (status === 'COMPLETED') {
        const read = resultOf(treeId, await handle.result() as AgentRunOutcome);
        return 'result' in read
          ? { state: 'finished', startedAt, ...(closedAt ? { closedAt } : {}), result: read.result }
          : { state: 'failed', startedAt, ...(closedAt ? { closedAt } : {}), reason: read.reason };
      }
      const said = await handle.result().then(() => undefined, (err: unknown) => err);
      return { state: 'failed', startedAt, ...(closedAt ? { closedAt } : {}), reason: failureReason(status, said) };
    },

    async signalGroveRun(treeId, which, ...args) {
      if (which === 'stopRun') return signal(groveRunWorkflowId(treeId));
      const runId = args[0] ? await deps.leafRun(args[0]) : undefined;
      return runId ? signal(runId) : false;
    },
  };
}
