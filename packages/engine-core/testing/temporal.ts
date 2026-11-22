import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Client } from '@temporalio/client';
import { temporal as proto } from '@temporalio/proto';
import { TestWorkflowEnvironment, TimeSkippingWorkflowClient } from '@temporalio/testing';
import { bundleWorkflowCode, type Worker, type WorkflowBundle } from '@temporalio/worker';
import { inject } from 'vitest';
import type { BlobReach, SecretKey, StoredBlob } from '../src/payload-codec.js';
import { createClient, createWorker, payloadConverter, type KoalaClientOptions, type KoalaWorkerOptions, type TemporalPayloads } from '../src/temporal.js';
import { OWNER_ATTRIBUTE, PROJECT_ATTRIBUTE } from '../src/workflow-owner.js';
import { temporalServerExecutable, temporalTestServerExecutable } from './shared.js';
import { tlsInFrontOf, type ServingCertificate } from './temporal-tls.js';

declare module 'vitest' {
  export interface ProvidedContext {
    temporalAddress: string;
    temporalTlsAddress: string;
    temporalCa: string;
  }
}

export interface MemoryBlobs extends BlobReach {
  readonly stored: Map<string, StoredBlob>;
}

export function memoryBlobs(): MemoryBlobs {
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
}

export interface TestPayloads extends TemporalPayloads {
  blobs: MemoryBlobs;
}

export const testPayloads = (ring: SecretKey = { current: randomBytes(32).toString('hex') }): TestPayloads => ({ ring, blobs: memoryBlobs() });

export type TestTemporal = TestWorkflowEnvironment & { readonly payloads: TemporalPayloads };

const carrying = (env: TestWorkflowEnvironment, payloads: TemporalPayloads): TestTemporal => Object.assign(env, { payloads });

const sealing = (payloads: TemporalPayloads) => ({ client: { dataConverter: payloadConverter(payloads) } });

export async function localTemporal(payloads: TemporalPayloads = testPayloads()): Promise<TestTemporal> {
  const env = await TestWorkflowEnvironment.createLocal({ server: { searchAttributes: [OWNER_ATTRIBUTE, PROJECT_ATTRIBUTE], executable: temporalServerExecutable() }, ...sealing(payloads) });
  return carrying(env, payloads);
}

export interface TemporalAt {
  namespace?: string;
  payloads?: TemporalPayloads;
}

export async function temporalAt(address: string = inject('temporalAddress'), at: TemporalAt = {}): Promise<TestTemporal> {
  const payloads = at.payloads ?? testPayloads();
  const env = await TestWorkflowEnvironment.createFromExistingServer({ address, ...(at.namespace ? { namespace: at.namespace } : {}), ...sealing(payloads) });
  return carrying(env, payloads);
}

export async function timeSkippingTemporal(payloads: TemporalPayloads = testPayloads()): Promise<TestTemporal> {
  const env = await TestWorkflowEnvironment.createTimeSkipping({ server: { executable: temporalTestServerExecutable() }, ...sealing(payloads) });
  return carrying(env, payloads);
}

export const temporal = (): Promise<TestTemporal> => temporalAt();

export type TestClientOptions = Omit<KoalaClientOptions, 'connection' | 'namespace' | 'payloads'> & { namespace?: string; payloads?: TemporalPayloads };

export const testClient = (env: TestTemporal, options: TestClientOptions = {}): Client =>
  createClient({ ...options, connection: env.connection, namespace: options.namespace ?? env.namespace ?? 'default', payloads: options.payloads ?? env.payloads });

export interface TimeSkippingClientOptions {
  namespace?: string;
  interceptors?: ConstructorParameters<typeof TimeSkippingWorkflowClient>[0]['interceptors'];
}

export const timeSkippingClient = (env: TestTemporal, options: TimeSkippingClientOptions = {}): TimeSkippingWorkflowClient =>
  new TimeSkippingWorkflowClient({ connection: env.connection, namespace: options.namespace ?? env.namespace ?? 'default', dataConverter: payloadConverter(env.payloads), ...(options.interceptors ? { interceptors: options.interceptors } : {}) });

export type TestWorkerOptions = Omit<KoalaWorkerOptions, 'connection' | 'namespace' | 'payloads' | 'deletingMarks'> & { namespace?: string; payloads?: TemporalPayloads; deletingMarks?: KoalaWorkerOptions['deletingMarks'] };

export async function testWorker(env: TestTemporal, options: TestWorkerOptions): Promise<Worker> {
  let refuse!: (why: Error) => void;
  const refused = new Promise<never>((_done, failed) => { refuse = failed; });
  refused.catch(() => undefined);
  const worker = await createWorker({
    ...options,
    deletingMarks: options.deletingMarks ?? { unread: 'this test worker reads no deletion marks' },
    connection: env.nativeConnection,
    namespace: options.namespace ?? env.namespace ?? 'default',
    payloads: options.payloads ?? env.payloads,
    onUnreadable: (why) => refuse(new Error(`this worker can never run the work it was handed: ${why.message}`)),
  });
  const runUntil = worker.runUntil.bind(worker);
  worker.runUntil = <R>(work: Promise<R> | (() => Promise<R>)): Promise<R> =>
    runUntil(() => Promise.race([typeof work === 'function' ? work() : work, refused]));
  return worker;
}

export interface TestTemporalServer {
  env: TestTemporal;
  address: string;
  tlsAddress: string;
  close(): Promise<void>;
}

export async function startTestTemporal(serving: ServingCertificate): Promise<TestTemporalServer> {
  const env = await localTemporal();
  const front = await tlsInFrontOf(env.address, serving);
  return {
    env,
    address: env.address,
    tlsAddress: front.address,
    close: async () => {
      await front.close();
      await env.teardown();
    },
  };
}

let bundle: Promise<WorkflowBundle> | undefined;

export const workflowBundle = (): Promise<WorkflowBundle> => {
  bundle ??= bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)) });
  return bundle;
};

export const queueFor = (what: string): string => `${what}-${randomUUID()}`;

export interface WatchedRun {
  running: Promise<void>;
  ended(): string | undefined;
}

export function watchedRun(worker: Pick<Worker, 'run'>): WatchedRun {
  let why: string | undefined;
  const running = worker.run().then(
    () => { why = 'the worker stopped'; },
    (err: unknown) => { why = `the worker failed: ${err instanceof Error ? err.message : String(err)}`; throw err; },
  );
  running.catch(() => undefined);
  return { running, ended: () => why };
}

export interface ActivityQueue {
  namespace?: string | undefined;
  queue: string;
}

export interface PollingAs extends ActivityQueue {
  identity?: string;
  ended(): string | undefined;
}

export async function pollersOf(client: Client, at: ActivityQueue): Promise<string[]> {
  const { pollers } = await client.workflowService.describeTaskQueue({
    namespace: at.namespace ?? 'default', taskQueue: { name: at.queue }, taskQueueType: proto.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
  });
  return (pollers ?? []).map((poller) => poller.identity ?? '');
}

export async function untilPolling(client: Client, wait: PollingAs): Promise<string[]> {
  for (;;) {
    const identities = await pollersOf(client, wait);
    if (wait.identity === undefined ? identities.length > 0 : identities.includes(wait.identity)) return identities;
    const why = wait.ended();
    if (why) throw new Error(`nothing polls ${wait.queue}${wait.identity === undefined ? '' : ` as ${wait.identity}`}, and nothing will: ${why}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}
