import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { workFor } from '@koala/engine-core/work-for';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundled, realTemporalEnvironment } from '../../workflows/temporal-test-env.js';
import { namesItsWork } from '../../platform/lib/temporal-client.js';
import { createAgentRegistry } from '../registries/registry.js';
import { createRunStarter } from '../registries/run-starter.js';
import { workflowOfRun } from './contracts.js';
import { temporalWorkflowStarter } from './workflow-starter.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await realTemporalEnvironment(); });
afterAll(async () => { await env?.teardown(); });

describe('a run started through Temporal for a project', () => {
  it('runs as its owner\'s work for that project, and hears every answer, approval and cancel sent to it', async () => {
    const taskQueue = `run-start-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({
      ...WORKER_DEFAULTS,
      interceptors: { activity: activityInterceptors() },
      connection: env.nativeConnection,
      namespace: env.namespace ?? 'default',
      taskQueue,
      workflowBundle: await bundled(resolve(import.meta.dirname, 'testing/run-start.fixture-workflow.ts'), [resolve(import.meta.dirname, '../../workflows/telemetry-interceptors.ts')]),
      activities: { SeenActivity: async () => workFor() ?? null },
    });
    const naming = new Client({ connection: env.connection, namespace: env.namespace ?? 'default', interceptors: { workflow: [namesItsWork] } });
    const runs = createRunStarter({ registry: createAgentRegistry(), workflows: () => temporalWorkflowStarter(naming.workflow), taskQueue, newRunId: () => `run-${taskQueue}` });
    await worker.runUntil(async () => {
      const { runId } = await runs.start({ ownerId: 'u1', agentSlug: 'research', message: 'look it up', projectId: 'p1' });
      await runs.approve(runId, 'call-1', true);
      await runs.cancel(runId, 'u1');
      await runs.answer(runId, 'n1', 'yes');
      expect(await naming.workflow.getHandle(workflowOfRun(runId)).result()).toEqual({ seen: { owner: 'u1', project: 'p1' }, answered: { nodeId: 'n1', value: 'yes' }, approved: { callId: 'call-1', allowed: true, forRun: false }, cancelledBy: 'u1' });
    });
  });
});
