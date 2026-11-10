import { activityInterceptors } from './classified-failures.js';
import { randomBytes } from 'node:crypto';
import { Client } from '@temporalio/client';
import { temporal as proto } from '@temporalio/proto';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDataConverter, OFFLOAD_ABOVE_BYTES, type BlobReach, type StoredBlob } from './payload-codec.js';
import { queueFor, temporal, workflowBundle } from '../testing/temporal.js';
import { echoed } from '../testing/workflows.js';

const KEY = 'payload-key-for-the-integration-tier';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporal();
});

afterAll(async () => {
  await env.teardown();
});

const blobStore = (): BlobReach & { stored: Map<string, StoredBlob> } => {
  const stored = new Map<string, StoredBlob>();
  return {
    stored,
    async put(blobs) { for (const blob of blobs) stored.set(blob.id, blob); },
    async get(ids) {
      return new Map(ids.flatMap((id) => {
        const blob = stored.get(id);
        return blob ? [[id, blob.data] as const] : [];
      }));
    },
  };
};

const clientWith = (key: string | undefined, blobs?: BlobReach): Client =>
  new Client({ connection: env.connection, namespace: env.namespace ?? 'default', dataConverter: buildDataConverter(key, blobs) });

async function echoedThrough(blobs: BlobReach, value: unknown): Promise<{ result: unknown; workflowId: string; history: Buffer }> {
  const taskQueue = queueFor('payloads');
  const workflowId = queueFor('echoed');
  const worker = await Worker.create({
    interceptors: { activity: activityInterceptors() },
    connection: env.nativeConnection,
    namespace: env.namespace ?? 'default',
    taskQueue,
    workflowBundle: await workflowBundle(),
    dataConverter: buildDataConverter(KEY, blobs),
    activities: { echo: async (given: unknown) => given, waitForStop: async () => 'never asked' },
  });
  const result = await worker.runUntil(clientWith(KEY, blobs).workflow.execute(echoed, { taskQueue, workflowId, args: [value] }));
  const { history } = await env.client.workflowService.getWorkflowExecutionHistory({ namespace: env.namespace ?? 'default', execution: { workflowId } });
  return { result, workflowId, history: Buffer.from(proto.api.history.v1.History.encode(history ?? {}).finish()) };
}

describe('payloads sealed on their way through Temporal', () => {
  it('come back as they were sent, and Temporal holds nothing of them it can read', async () => {
    const blobs = blobStore();
    const value = { said: 'the sealed marker text 7f3a', count: 3, nested: { list: [1, 2, 3] } };

    const { result, history } = await echoedThrough(blobs, value);

    expect(result).toEqual(value);
    expect(history.includes('the sealed marker text 7f3a')).toBe(false);
    expect(history.includes('binary/encrypted-aes-256-gcm')).toBe(true);
    expect(blobs.stored.size).toBe(0);
  });

  it('keep a payload too big for Temporal outside it, tied to its workflow, with only a claim in the history', async () => {
    const blobs = blobStore();
    const big = randomBytes(OFFLOAD_ABOVE_BYTES * 2).toString('base64');

    const { result, workflowId, history } = await echoedThrough(blobs, big);

    expect(result).toBe(big);
    expect(blobs.stored.size).toBeGreaterThanOrEqual(4);
    expect([...blobs.stored.values()].every((blob) => blob.workflowId === workflowId)).toBe(true);
    expect(history.length).toBeLessThan(OFFLOAD_ABOVE_BYTES);
    expect(history.includes(big.slice(0, 64))).toBe(false);
  });

  it('cannot be read by a client holding another key', async () => {
    const blobs = blobStore();
    const { workflowId } = await echoedThrough(blobs, 'only for the right key');

    const failure = await clientWith('another key', blobs).workflow.getHandle<typeof echoed>(workflowId).result().catch((err: unknown) => err);

    expect((failure as Error).message).toMatch(/^Failed to decrypt a Temporal payload/);
  });

  it('cannot be read by a client that does not decrypt at all', async () => {
    const blobs = blobStore();
    const { workflowId } = await echoedThrough(blobs, 'sealed');

    const failure = await clientWith(undefined, blobs).workflow.getHandle<typeof echoed>(workflowId).result().catch((err: unknown) => err);

    expect((failure as Error).message).toBe('Unknown encoding: binary/encrypted-aes-256-gcm');
  });

  it('cannot be read once the store outside Temporal has lost the payload', async () => {
    const blobs = blobStore();
    const { workflowId } = await echoedThrough(blobs, randomBytes(OFFLOAD_ABOVE_BYTES * 2).toString('base64'));
    blobs.stored.clear();

    const failure = await clientWith(KEY, blobs).workflow.getHandle<typeof echoed>(workflowId).result().catch((err: unknown) => err);

    expect((failure as Error).message).toMatch(/a Temporal payload stored outside Temporal is missing \(blob [0-9a-f-]{36}\)/);
  });
});
