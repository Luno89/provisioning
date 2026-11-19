import { TimeSkippingWorkflowClient } from '@temporalio/testing';
import { bundleWorkflowCode, type WorkflowBundle } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import { Connection, type Client } from '@temporalio/client';
import Long from 'long';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import type { TemporalPayloads } from '@koala/engine-core/temporal';
import { localTemporal, temporalAt, testClient, testPayloads, timeSkippingClient, timeSkippingTemporal, type TestTemporal } from '@koala/engine-core/testing/temporal';
import { registerOwnerAttribute } from '../../platform/lib/temporal-client.js';

export type { TestTemporal } from '@koala/engine-core/testing/temporal';

export interface FreshNamespace {
  namespace: string;
  drop(): Promise<void>;
}

export async function freshNamespace(address: string = inject('temporalAddress')): Promise<FreshNamespace> {
  const connection = await Connection.connect({ address });
  const namespace = `koala-test-${randomUUID()}`;
  await connection.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: { seconds: Long.fromNumber(86_400) } });
  await registerOwnerAttribute(connection, namespace);
  return {
    namespace,
    drop: async () => {
      await connection.operatorService.deleteNamespace({ namespace });
      await connection.close();
    },
  };
}

export async function realTemporalEnvironment(payloads: TemporalPayloads = testPayloads()): Promise<TestTemporal> {
  const address = inject('temporalAddress');
  if (!address) return localTemporal(payloads);
  const fresh = await freshNamespace(address);
  const env = await temporalAt(address, { namespace: fresh.namespace, payloads });
  const teardown = env.teardown.bind(env);
  env.teardown = async () => {
    await teardown();
    await fresh.drop();
  };
  return env;
}

export async function clockSkippingEnvironment(payloads: TemporalPayloads = testPayloads()): Promise<TestTemporal> {
  const env = await timeSkippingTemporal(payloads);
  await registerOwnerAttribute(env.connection, env.namespace ?? 'default');
  return env;
}

export interface TestWorld {
  namespace: string;
  client: Client;
}

export async function newWorld(env: TestTemporal): Promise<TestWorld> {
  if (!env.supportsTimeSkipping) throw new Error('a world of its own is a namespace the time-skipping server makes on first use; on a real server, take a freshNamespace');
  const namespace = `world-${randomUUID()}`;
  await registerOwnerAttribute(env.connection, namespace);
  const client = testClient(env, { namespace });
  if (env.client.workflow instanceof TimeSkippingWorkflowClient) Object.defineProperty(client, 'workflow', { value: timeSkippingClient(env, { namespace }) });
  return { namespace, client };
}

export interface WorldPerTest {
  readonly env: TestTemporal;
  readonly world: TestWorld;
}

export function worldPerTest(): WorldPerTest {
  let env: TestTemporal | undefined;
  let world: TestWorld | undefined;
  beforeAll(async () => { env = await clockSkippingEnvironment(); });
  beforeEach(async () => { world = await newWorld(made(env)); });
  afterAll(async () => { await env?.teardown(); });
  return {
    get env() { return made(env); },
    get world() { return made(world); },
  };
}

const made = <T>(thing: T | undefined): T => {
  if (thing === undefined) throw new Error('this file\'s Temporal environment and world are made in beforeAll and beforeEach; a test reached them before they were made');
  return thing;
};

export async function temporalTestEnvironment(payloads: TemporalPayloads = testPayloads()): Promise<TestTemporal> {
  const env = await clockSkippingEnvironment(payloads);
  Object.defineProperty(env, 'client', { value: testClient(env) });
  return env;
}

const bundles = new Map<string, Promise<WorkflowBundle>>();

export function bundled(workflowsPath: string, workflowInterceptorModules: string[] = []): Promise<WorkflowBundle> {
  const key = [workflowsPath, ...workflowInterceptorModules].join('\n');
  let bundle = bundles.get(key);
  if (!bundle) {
    bundle = bundleWorkflowCode({ workflowsPath, workflowInterceptorModules });
    bundles.set(key, bundle);
  }
  return bundle;
}
