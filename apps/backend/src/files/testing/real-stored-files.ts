import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { inject } from 'vitest';
import { DEFAULT_STREAM_TASK_QUEUE } from '../../engine-host/temporal/contracts.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { bundled, temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import type { StoredFilesActivities } from '../lib/stored-files-work.js';
import { minioObjectStore, type ObjectStore } from '../services/ObjectStore.js';
import { createStoredFilesActivities } from '../services/stored-files-activities.js';
import { temporalStoredFileCommits } from '../services/StoredFileCommits.js';
import { roomOn } from '../services/room.js';
import { StoredFiles } from '../services/StoredFiles.js';
import { testBucket } from './real-minio.js';

export interface RealStoredFiles {
  db: Database;
  files: StoredFiles;
  objects: ObjectStore;
  activities: StoredFilesActivities;
  clock: { now: number };
  stop(): Promise<void>;
}

export async function realStoredFiles(): Promise<RealStoredFiles> {
  const env: TestWorkflowEnvironment = await temporalTestEnvironment();
  const db = await testDatabase();
  const objects = minioObjectStore({ ...inject('minio'), bucket: testBucket() });
  const clock = { now: Date.now() };
  const activities = createStoredFilesActivities({ records: db.files, objects, now: () => clock.now });
  const queue = `stored-files-${randomUUID().slice(0, 8)}`;
  const namespace = env.namespace ?? 'default';
  const workflows = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace, taskQueue: queue, workflowBundle: await bundled(resolve(import.meta.dirname, '../../workflows/StoredFilesWorkflow.ts')) });
  const stream = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace, taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities });
  const running = Promise.all([workflows.run(), stream.run()]);
  const files = new StoredFiles({ records: db.files, objects, commits: temporalStoredFileCommits(async () => env.client.workflow, queue), room: roomOn(tmpdir()), now: () => clock.now });
  return {
    db, files, objects, activities, clock,
    async stop() {
      workflows.shutdown();
      stream.shutdown();
      await running;
      await env.teardown();
    },
  };
}
