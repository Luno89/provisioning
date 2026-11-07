import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DEFAULT_STREAM_TASK_QUEUE } from '../../engine-host/temporal/contracts.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { bundled, temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { testBucket } from '../testing/real-minio.js';
import { storedFilesContract, type StoredFilesWorld } from '../testing/stored-files-contract.js';
import { minioObjectStore } from './ObjectStore.js';
import { createStoredFilesActivities } from './stored-files-activities.js';
import { temporalStoredFileCommits } from './StoredFileCommits.js';
import { StoredFiles } from './StoredFiles.js';

let env: TestWorkflowEnvironment;
let world: StoredFilesWorld;
let stop: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  env = await temporalTestEnvironment();
  const db = await testDatabase();
  const objects = minioObjectStore({ ...inject('minio'), bucket: testBucket() });
  const clock = { now: Date.now() };
  const activities = createStoredFilesActivities({ records: db.files, objects, now: () => clock.now });
  const queue = `stored-files-${randomUUID().slice(0, 8)}`;
  const namespace = env.namespace ?? 'default';
  const workflows = await Worker.create({ ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace, taskQueue: queue, workflowBundle: await bundled(resolve(import.meta.dirname, '../../workflows/StoredFilesWorkflow.ts')) });
  const stream = await Worker.create({ ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace, taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities });
  const running = Promise.all([workflows.run(), stream.run()]);
  stop = async () => {
    workflows.shutdown();
    stream.shutdown();
    await running;
  };
  const commits = temporalStoredFileCommits(async () => env.client.workflow, queue);
  const files = new StoredFiles({ records: db.files, objects, commits, now: () => clock.now });
  world = { files, objects, records: db.files, commits, sweep: () => activities.StoredFilesSweepActivity(), clock };
}, 300_000);

afterAll(async () => {
  await stop();
  await env?.teardown();
});

storedFilesContract(async () => world);

describe('what keeping a file through Temporal costs', () => {
  it('records how long an upload takes from its first byte to being kept, on this computer', async ({ annotate }) => {
    const folder = world.files.at(`u-${randomUUID().slice(0, 8)}`, { kind: 'project', id: 'timing' });
    const times: number[] = [];
    for (let n = 0; n < 10; n += 1) {
      const started = performance.now();
      const kept = await folder.upload(`t${n}.txt`, Readable.from([Buffer.from('x')]), 1, 'text/plain', { replace: true });
      times.push(performance.now() - started);
      expect(kept.ok).toBe(true);
    }
    const sorted = [...times].sort((a, b) => a - b);
    await annotate(`a one-byte upload kept through Temporal: median ${sorted[5]!.toFixed(0)} ms, slowest ${sorted[9]!.toFixed(0)} ms over 10`);
  });
});
