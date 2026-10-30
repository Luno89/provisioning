import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import { MachineRunWatch } from '../../machines/services/MachineRunWatch.js';
import { runClosedVia, runLifeVia } from './run-cancellation.js';

const QUEUE = 'run-life-test';
let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;
let client: () => Promise<Client>;

const start = (runId: string, owner = 'owner-1') =>
  env.client.workflow.start('heldRun', { taskQueue: QUEUE, workflowId: runId, ...startedFor(owner) });

beforeAll(async () => {
  env = await temporalTestEnvironment();
  worker = await Worker.create({ connection: env.nativeConnection, taskQueue: QUEUE, workflowsPath: resolve(__dirname, 'run-cancellation.fixture-workflow.ts') });
  running = worker.run();
  client = async () => env.client;
}, 120_000);

afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
}, 60_000);

describe('whether a run still runs, read from Temporal', () => {
  it('is running while its workflow runs, only for its owner, and ended once it finishes, is terminated or never was', async () => {
    const life = runLifeVia(client);
    const handle = await start('chat-1-koala-1');
    expect(await life('chat-1-koala-1', 'owner-1')).toBe('running');
    expect(await life('chat-1-koala-1', 'owner-2')).toBe('not-theirs');
    await handle.signal('finish');
    await handle.result();
    expect(await life('chat-1-koala-1', 'owner-1')).toBe('ended');
    const terminated = await start('chat-2-koala-1');
    await terminated.terminate('stopped by hand');
    expect(await life('chat-2-koala-1', 'owner-1')).toBe('ended');
    expect(await life('chat-never-koala-1', 'owner-1')).toBe('ended');
  }, 60_000);

  it('hears the moment a run closes, however it closes, without asking on a clock', async () => {
    const closed = runClosedVia(client, 60_000);
    const finished = await start('chat-3-koala-1');
    let heard: string | undefined;
    const waiting = closed('chat-3-koala-1', 'owner-1').then((life) => { heard = life; });
    await new Promise((done) => setTimeout(done, 300));
    expect(heard).toBeUndefined();
    await finished.signal('finish');
    await waiting;
    expect(heard).toBe('ended');
    const terminated = await start('chat-4-koala-1');
    const ending = closed('chat-4-koala-1', 'owner-1');
    await terminated.terminate('stopped by hand');
    expect(await ending).toBe('ended');
  }, 60_000);
});

describe('a machine told when the runs holding its sessions end', () => {
  it('is told once each run it names ends, and never about another person\'s run', async () => {
    const told: string[] = [];
    const logged: string[] = [];
    const watch = new MachineRunWatch({ life: runLifeVia(client), closed: runClosedVia(client, 60_000) }, (line) => logged.push(line));
    const mine = await start('chat-5-koala-1');
    await start('chat-6-koala-1', 'someone-else');
    await start('chat-7-koala-1');
    const tell = (runId: string) => told.push(runId);
    watch.follow('desk', 'owner-1', { runIds: ['chat-5-koala-1', 'chat-6-koala-1', 'chat-7-koala-1', 'chat-gone-koala-1'] }, tell);
    await waitFor(() => told.includes('chat-gone-koala-1') && logged.length === 1);
    expect(told).toEqual(['chat-gone-koala-1']);
    expect(logged[0]).toMatch(/desk named chat-6-koala-1, which is not its owner's run/);
    await mine.signal('finish');
    await waitFor(() => told.includes('chat-5-koala-1'));
    watch.follow('desk', 'owner-1', { runIds: [] }, tell);
    await env.client.workflow.getHandle('chat-7-koala-1').terminate('stopped by hand');
    await new Promise((done) => setTimeout(done, 500));
    expect(told).toEqual(['chat-gone-koala-1', 'chat-5-koala-1']);
    expect(watch.watching('desk')).toEqual([]);
  }, 60_000);
});

async function waitFor(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((next) => setTimeout(next, 20));
}
