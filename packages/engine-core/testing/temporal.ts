import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, type Worker, type WorkflowBundle } from '@temporalio/worker';
import { inject } from 'vitest';
import type { BlobReach, SecretKey, StoredBlob } from '../src/payload-codec.js';
import { createClient, createWorker, payloadConverter, type KoalaClientOptions, type KoalaWorkerOptions, type TemporalPayloads } from '../src/temporal.js';
import { OWNER_ATTRIBUTE } from '../src/workflow-owner.js';
import { temporalServerExecutable } from './shared.js';
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
  const env = await TestWorkflowEnvironment.createLocal({ server: { searchAttributes: [OWNER_ATTRIBUTE], executable: temporalServerExecutable() }, ...sealing(payloads) });
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
  const env = await TestWorkflowEnvironment.createTimeSkipping(sealing(payloads));
  return carrying(env, payloads);
}

export const temporal = (): Promise<TestTemporal> => temporalAt();

export type TestClientOptions = Omit<KoalaClientOptions, 'connection' | 'namespace' | 'payloads'> & { namespace?: string };

export const testClient = (env: TestTemporal, options: TestClientOptions = {}): Client =>
  createClient({ ...options, connection: env.connection, namespace: options.namespace ?? env.namespace ?? 'default', payloads: env.payloads });

export type TestWorkerOptions = Omit<KoalaWorkerOptions, 'connection' | 'namespace' | 'payloads'> & { namespace?: string };

export const testWorker = (env: TestTemporal, options: TestWorkerOptions): Promise<Worker> =>
  createWorker({ ...options, connection: env.nativeConnection, namespace: options.namespace ?? env.namespace ?? 'default', payloads: env.payloads });

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
