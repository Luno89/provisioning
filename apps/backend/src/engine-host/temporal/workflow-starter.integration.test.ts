import { workFor } from '@koala/engine-core/work-for';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { bundled, realTemporalEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { namesItsWork } from '../../platform/lib/temporal-client.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { createAgentRegistry } from '../registries/registry.js';
import { createRunStarter, type WorkflowStarter } from '../registries/run-starter.js';
import { workflowOfRun, type ProcedureRunInput } from './contracts.js';
import { temporalWorkflowStarter } from './workflow-starter.js';
import { environmentForFile, testWorker } from '../../workflows/testing/test-worker.js';
import { testClient } from '@koala/engine-core/testing/temporal';
import { grantsOver, runsActingAsTheirOwner } from '../../engine/testing/run-grants.js';

const file = environmentForFile(realTemporalEnvironment);

describe('a run started through Temporal for a project', () => {
  it('runs as its owner\'s work for that project, and hears every answer, approval and cancel sent to it', async () => {
    const taskQueue = `run-start-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await testWorker(file.env, {
      namespace: file.env.namespace ?? 'default',
      taskQueue,
      workflowBundle: await bundled(resolve(import.meta.dirname, 'testing/run-start.fixture-workflow.ts'), [resolve(import.meta.dirname, '../../workflows/telemetry-interceptors.ts')]),
      activities: { SeenActivity: async () => workFor() ?? null },
    });
    const naming = testClient(file.env, { interceptors: { workflow: [namesItsWork] } });
    const runs = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => temporalWorkflowStarter(naming.workflow), taskQueue, newRunId: () => `run-${taskQueue}` });
    await worker.runUntil(async () => {
      const { runId } = await runs.start({ ownerId: 'u1', agentSlug: 'research', message: 'look it up', projectId: 'p1', startedBy: 'person' });
      await runs.approve(runId, 'call-1', true);
      await runs.cancel(runId, 'u1');
      await runs.answer(runId, 'n1', 'yes');
      expect(await naming.workflow.getHandle(workflowOfRun(runId)).result()).toEqual({ seen: { owner: 'u1', project: 'p1' }, answered: { nodeId: 'n1', value: 'yes' }, approved: { callId: 'call-1', allowed: true, forRun: false }, cancelledBy: 'u1' });
    });
  });
});

describe('two processes starting the same run at once through Temporal', () => {
  it('leaves only the started run\'s grant, the one its ticket carries', async () => {
    const taskQueue = `run-race-${Math.random().toString(36).slice(2, 8)}`;
    const db = await testDatabase();
    const grants = grantsOver(db.engine);
    const naming = testClient(file.env, { interceptors: { workflow: [namesItsWork] } });
    const temporal = temporalWorkflowStarter(naming.workflow);
    let arrived = 0;
    let release!: () => void;
    const bothIssued = new Promise<void>((resolve) => { release = resolve; });
    let firstAnswered!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstAnswered = resolve; });
    const held = (who: 'first' | 'second'): WorkflowStarter => ({
      async start(type, options) {
        arrived += 1;
        if (arrived === 2) release();
        await bothIssued;
        if (who === 'second') await firstStarted;
        try {
          return await temporal.start(type, options);
        } finally {
          if (who === 'first') firstAnswered();
        }
      },
    });
    const starter = (who: 'first' | 'second') => createRunStarter({ ...runsActingAsTheirOwner(grants), registry: createAgentRegistry(), workflows: () => held(who), taskQueue, newRunId: () => `run-${taskQueue}` });

    const [won, lost] = await Promise.allSettled([
      starter('first').start({ ownerId: 'u1', agentSlug: 'research', message: 'look it up', startedBy: 'person' }),
      starter('second').start({ ownerId: 'u1', agentSlug: 'research', message: 'look it up', startedBy: 'person' }),
    ]);

    expect(won.status).toBe('fulfilled');
    expect(lost.status === 'rejected' && lost.reason).toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
    const live = await db.engine.getLiveRunGrants('u1');
    expect(live).toHaveLength(1);
    const history = await naming.workflow.getHandle(workflowOfRun(`run-${taskQueue}`)).fetchHistory();
    const started = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
    const { payloadCodecs, payloadConverter } = naming.options.loadedDataConverter;
    let opened = started ? [started] : [];
    for (const codec of [...payloadCodecs].reverse()) opened = await codec.decode(opened);
    const input = opened[0] ? payloadConverter.fromPayload<ProcedureRunInput>(opened[0]) : undefined;
    expect(input?.ticket.grantId).toBe(live[0]!.id);
    await naming.workflow.getHandle(workflowOfRun(`run-${taskQueue}`)).cancel();
  });
});
