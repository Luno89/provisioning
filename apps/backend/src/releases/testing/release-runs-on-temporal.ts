import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { engineReleaseRuns } from '../../engine-host/release-runs.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import { bundled, realTemporalEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { releaseRunWorkflowId } from '../lib/release-run.js';
import type { ReleaseRuns } from '../services/OdooReleaseService.js';
import { releaseAwaitingPerson } from './awaiting-person.fixture-workflow.js';

export interface StartedRelease {
  agent: string;
  projectId: string;
  inputs: Record<string, unknown>;
}

export interface ReleaseRunsOnTemporal {
  runs: ReleaseRuns;
  started: StartedRelease[];
  answers(projectId: string): Promise<string[]>;
  end(projectId: string): Promise<void>;
  close(): Promise<void>;
}

const WORKFLOWS = fileURLToPath(new URL('./awaiting-person.fixture-workflow.ts', import.meta.url));

export async function releaseRunsOnTemporal(): Promise<ReleaseRunsOnTemporal> {
  const env: TestWorkflowEnvironment = await realTemporalEnvironment();
  const taskQueue = `release-route-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue, workflowBundle: await bundled(WORKFLOWS) });
  const working = worker.run();
  const started: StartedRelease[] = [];
  const runs = engineReleaseRuns({
    runs: {
      start: async (request) => {
        const projectId = String(request.bound?.projectId);
        started.push({ agent: request.agentSlug, projectId, inputs: request.inputs ?? {} });
        await env.client.workflow.start(releaseAwaitingPerson, { taskQueue, workflowId: releaseRunWorkflowId(projectId), ...startedFor(request.ownerId) });
        return { runId: request.runId ?? '' } as never;
      },
    },
    client: () => env.client.workflow,
  });
  const handle = (projectId: string) => env.client.workflow.getHandle(releaseRunWorkflowId(projectId));
  return {
    runs,
    started,
    answers: (projectId) => handle(projectId).query<string[]>('answered'),
    end: async (projectId) => {
      if (!(await runs.running(projectId))) return;
      await runs.stop(projectId);
      await handle(projectId).result();
    },
    close: async () => {
      worker.shutdown();
      await working;
      await env.teardown();
    },
  };
}
