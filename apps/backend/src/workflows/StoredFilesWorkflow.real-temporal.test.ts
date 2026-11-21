import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import type { StoredFilesActivities } from '../files/lib/stored-files-work.js';
import { createStoredFilesActivities } from '../files/services/stored-files-activities.js';
import { EVERY_PROJECT_OPEN } from '../files/testing/stored-files-twin.js';
import { temporalStoredFileCommits } from '../files/services/StoredFileCommits.js';
import { MemoryFilesStore } from '../files/testing/memory-store.js';
import { MemoryObjectStore } from '../files/testing/memory-object-store.js';
import { bundled, temporalTestEnvironment, newWorld, type TestWorld } from './testing/temporal-test-env.js';
import { testWorker } from './testing/test-worker.js';
import type { TestTemporal } from '@koala/engine-core/testing/temporal';

let env: TestTemporal;
const AT = '2026-11-07T10:00:00.000Z';
const scope = { kind: 'project', id: 'p1' } as const;

beforeAll(async () => {
  env = await temporalTestEnvironment();
});

let world: TestWorld;

beforeEach(async () => {
  world = await newWorld(env);
});

afterAll(async () => {
  await env?.teardown();
});

const begun = async (records: MemoryFilesStore, objects: MemoryObjectStore, id: string, path: string, text: string): Promise<void> => {
  await records.beginStoredFile({ id, objectId: id, ownerId: 'u1', scope: { ...scope }, path, kind: 'file', size: 0, contentType: 'text/plain', version: 0, madeAt: AT, changedAt: AT, state: 'uploading', touchedAt: AT });
  await objects.put(id, Readable.from([Buffer.from(text)]), text.length, 'text/plain');
};

async function running<T>(activities: StoredFilesActivities, work: (queue: string) => Promise<T>): Promise<T> {
  const queue = `stored-files-${randomUUID().slice(0, 8)}`;
  const namespace = world.namespace;
  const workflows = await testWorker(env, { namespace, taskQueue: queue, workflowBundle: await bundled(resolve(import.meta.dirname, 'StoredFilesWorkflow.ts')) });
  const stream = await testWorker(env, { namespace, taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities });
  return workflows.runUntil(stream.runUntil(work(queue)));
}

async function anOldVersionAndANewUpload(): Promise<{ records: MemoryFilesStore; objects: MemoryObjectStore }> {
  const records = new MemoryFilesStore();
  const objects = new MemoryObjectStore();
  await begun(records, objects, 'old', 'a.txt', 'old');
  await records.commitStoredFiles([{ id: 'old', size: 3 }], { replace: true, holdOpen: EVERY_PROJECT_OPEN }, AT);
  await begun(records, objects, 'new', 'a.txt', 'newer');
  return { records, objects };
}

describe('the stored files workflow on Temporal', () => {
  it('commits an upload as the next version of the file at its path, and removes the bytes it replaced', async () => {
    const { records, objects } = await anOldVersionAndANewUpload();
    const plan = await running(createStoredFilesActivities({ records, objects, holdOpen: EVERY_PROJECT_OPEN }), (queue) => temporalStoredFileCommits(async () => world.client.workflow, queue).commit('u1', [{ id: 'new', size: 5 }], { replace: true }));
    expect(plan).toMatchObject({ ok: true, replaced: ['old'], absorbed: ['new'] });
    expect([...objects.kept.keys()]).toEqual(['new']);
    expect((await records.storedFilesIn('u1', scope)).map((record) => [record.id, record.objectId, record.version])).toEqual([['old', 'new', 2]]);
    expect(await records.storedFileById('new')).toBeUndefined();
  });

  it('replaces exactly once when the worker dies after replacing and before it could answer, the bytes it replaced left for the sweep', async () => {
    const { records, objects } = await anOldVersionAndANewUpload();
    const real = createStoredFilesActivities({ records, objects, holdOpen: EVERY_PROJECT_OPEN });
    const removed: string[] = [];
    let attempts = 0;
    const dying: StoredFilesActivities = {
      ...real,
      async StoredFilesCommitActivity(args) {
        attempts += 1;
        const plan = await real.StoredFilesCommitActivity(args);
        if (attempts === 1) throw Object.assign(new Error('the connection to Temporal was cut off before the worker answered'), { code: 'ECONNRESET' });
        return plan;
      },
      StoredFilesRemoveBytesActivity: async (args) => { removed.push(...args.objectIds); return real.StoredFilesRemoveBytesActivity(args); },
    };
    const plan = await running(dying, (queue) => temporalStoredFileCommits(async () => world.client.workflow, queue).commit('u1', [{ id: 'new', size: 5 }], { replace: true }));
    expect(attempts).toBe(2);
    expect(plan).toMatchObject({ ok: true, replaced: [], absorbed: [], stored: [{ id: 'old', objectId: 'new', version: 2 }] });
    expect(removed).toEqual([]);
    expect((await records.storedFilesIn('u1', scope)).map((record) => [record.id, record.objectId, record.version])).toEqual([['old', 'new', 2]]);
    expect([...objects.kept.keys()].sort()).toEqual(['new', 'old']);
    expect(await real.StoredFilesSweepActivity()).toEqual({ deadUploads: 0, expired: 0, orphans: 1 });
    expect([...objects.kept.keys()]).toEqual(['new']);
  });

  it('commits exactly once when the worker dies after committing and before it could answer', async () => {
    const records = new MemoryFilesStore();
    const objects = new MemoryObjectStore();
    await begun(records, objects, 'f1', 'once.txt', 'once');
    const real = createStoredFilesActivities({ records, objects, holdOpen: EVERY_PROJECT_OPEN });
    let attempts = 0;
    const dying: StoredFilesActivities = {
      ...real,
      async StoredFilesCommitActivity(args) {
        attempts += 1;
        const plan = await real.StoredFilesCommitActivity(args);
        if (attempts === 1) throw Object.assign(new Error('the connection to Temporal was cut off before the worker answered'), { code: 'ECONNRESET' });
        return plan;
      },
    };
    const plan = await running(dying, (queue) => temporalStoredFileCommits(async () => world.client.workflow, queue).commit('u1', [{ id: 'f1', size: 4 }], { replace: false }));
    expect(attempts).toBe(2);
    expect(plan).toMatchObject({ ok: true });
    expect((await records.storedFilesIn('u1', scope)).map((record) => [record.id, record.version, record.state])).toEqual([['f1', 1, 'stored']]);
    expect([...objects.kept.keys()]).toEqual(['f1']);
  });

  it('forgets a refused upload and its bytes, and removes files record first, then bytes', async () => {
    const records = new MemoryFilesStore();
    const objects = new MemoryObjectStore();
    await begun(records, objects, 'mine', 'a.txt', 'mine');
    await records.commitStoredFiles([{ id: 'mine', size: 4 }], { replace: true, holdOpen: EVERY_PROJECT_OPEN }, AT);
    await begun(records, objects, 'theirs', 'a.txt', 'theirs');
    const order: string[] = [];
    const real = createStoredFilesActivities({ records, objects, holdOpen: EVERY_PROJECT_OPEN });
    const watched: StoredFilesActivities = {
      ...real,
      StoredFilesForgetActivity: async (args) => { order.push(`forget ${args.ids.join(',')}`); return real.StoredFilesForgetActivity(args); },
      StoredFilesRemoveBytesActivity: async (args) => { order.push(`bytes ${args.objectIds.join(',')}`); return real.StoredFilesRemoveBytesActivity(args); },
    };
    await running(watched, async (queue) => {
      const commits = temporalStoredFileCommits(async () => world.client.workflow, queue);
      expect(await commits.commit('u1', [{ id: 'theirs', size: 6 }], { replace: false })).toMatchObject({ ok: false, status: 409 });
      await commits.remove('u1', [(await records.storedFileById('mine'))!]);
    });
    expect(order).toEqual(['forget theirs', 'bytes theirs', 'forget mine', 'bytes mine']);
    expect(objects.kept.size).toBe(0);
    expect(await records.storedFileById('theirs')).toBeUndefined();
  });
});
