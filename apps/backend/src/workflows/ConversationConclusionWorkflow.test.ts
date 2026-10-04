import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ConversationConclusionWorkflow, turnEndedSignal, turnStartedSignal } from './ConversationConclusionWorkflow.js';
import { DEFAULT_STREAM_TASK_QUEUE, type LifecycleEvent } from '../engine-host/temporal/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe('a conversation\'s countdown to concluding', () => {
  it('concludes once the conversation has been quiet for the agent\'s time after its last turn, and a new message starts the count again', async () => {
    const taskQueue = `conclusion-test-${Math.random().toString(36).slice(2, 8)}`;
    const concluded: LifecycleEvent[] = [];
    const timers = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: resolve(__dirname, 'ConversationConclusionWorkflow.ts') });
    const backend = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: DEFAULT_STREAM_TASK_QUEUE,
      activities: { EngineLifecycleActivity: async (event: LifecycleEvent) => { concluded.push(event); } },
    });

    await timers.runUntil(() => backend.runUntil(async () => {
      const client = env.client.workflow;
      const where = { workflowId: 'conclude-conversation-c1', taskQueue, args: [{ ownerId: 'u1', conversationId: 'c1' }] as [{ ownerId: string; conversationId: string }] };
      const start = (signal: 'turnEnded' | 'turnStarted', args: [{ quietMs: number }] | []) => (signal === 'turnEnded'
        ? client.signalWithStart(ConversationConclusionWorkflow, { ...where, signal: turnEndedSignal, signalArgs: args as [{ quietMs: number }] })
        : client.signalWithStart(ConversationConclusionWorkflow, { ...where, signal: turnStartedSignal, signalArgs: [] }));

      const handle = await start('turnEnded', [{ quietMs: 10 * MINUTE }]);
      await env.sleep(8 * MINUTE);
      expect(concluded).toEqual([]);

      await start('turnStarted', []);
      await env.sleep(30 * MINUTE);
      expect(concluded, 'it concluded while a turn was still running').toEqual([]);

      await start('turnEnded', [{ quietMs: 10 * MINUTE }]);
      await env.sleep(9 * MINUTE);
      expect(concluded, 'it concluded before ten quiet minutes had passed since the last turn').toEqual([]);

      await handle.result();
      expect(concluded).toEqual([{ kind: 'conversation-quiet', ownerId: 'u1', conversationId: 'c1' }]);
    }));
  }, 120_000);

  it('follows the time the agent is configured with', async () => {
    const taskQueue = `conclusion-test-${Math.random().toString(36).slice(2, 8)}`;
    const concluded: LifecycleEvent[] = [];
    const timers = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: resolve(__dirname, 'ConversationConclusionWorkflow.ts') });
    const backend = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: DEFAULT_STREAM_TASK_QUEUE,
      activities: { EngineLifecycleActivity: async (event: LifecycleEvent) => { concluded.push(event); } },
    });

    await timers.runUntil(() => backend.runUntil(async () => {
      const handle = await env.client.workflow.signalWithStart(ConversationConclusionWorkflow, {
        workflowId: 'conclude-conversation-c2',
        taskQueue,
        args: [{ ownerId: 'u1', conversationId: 'c2' }],
        signal: turnEndedSignal,
        signalArgs: [{ quietMs: 2 * MINUTE }],
      });
      await env.sleep(MINUTE);
      expect(concluded).toEqual([]);
      await handle.result();
      expect(concluded).toHaveLength(1);
    }));
  }, 120_000);
});
