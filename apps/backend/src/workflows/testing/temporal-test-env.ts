import { TestWorkflowEnvironment, TimeSkippingWorkflowClient } from '@temporalio/testing';
import { temporalServerExecutable } from '@koala/engine-core/testing/shared';
import { bundleWorkflowCode, type WorkflowBundle } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { inject } from 'vitest';
import { OWNER_ATTRIBUTE } from '../../platform/lib/workflow-owner.js';
import { readyNamespace, registerOwnerAttribute } from '../../platform/lib/temporal-client.js';

declare module 'vitest' {
  export interface ProvidedContext {
    temporalAddress: string;
    temporalTlsAddress: string;
    temporalCa: string;
  }
}

export interface FreshNamespace {
  namespace: string;
  drop(): Promise<void>;
}

export async function freshNamespace(address: string = inject('temporalAddress')): Promise<FreshNamespace> {
  const connection = await Connection.connect({ address });
  const namespace = `koala-test-${randomUUID()}`;
  await readyNamespace(connection, namespace);
  return {
    namespace,
    drop: async () => {
      await connection.operatorService.deleteNamespace({ namespace });
      await connection.close();
    },
  };
}

export async function realTemporalEnvironment(): Promise<TestWorkflowEnvironment> {
  const address = inject('temporalAddress');
  if (!address) return TestWorkflowEnvironment.createLocal({ server: { searchAttributes: [OWNER_ATTRIBUTE], executable: temporalServerExecutable() } });
  const fresh = await freshNamespace(address);
  const env = await TestWorkflowEnvironment.createFromExistingServer({ address, namespace: fresh.namespace });
  const teardown = env.teardown.bind(env);
  env.teardown = async () => {
    await teardown();
    await fresh.drop();
  };
  return env;
}

export async function clockSkippingEnvironment(): Promise<TestWorkflowEnvironment> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  await registerOwnerAttribute(env.connection, env.namespace ?? 'default');
  return env;
}

export interface TestWorld {
  namespace: string;
  client: Client;
}

export async function newWorld(env: TestWorkflowEnvironment): Promise<TestWorld> {
  if (!env.supportsTimeSkipping) throw new Error('a world of its own is a namespace the time-skipping server makes on first use; on a real server, take a freshNamespace');
  const namespace = `world-${randomUUID()}`;
  await registerOwnerAttribute(env.connection, namespace);
  const client = new Client({ connection: env.connection, namespace });
  if (env.client.workflow instanceof TimeSkippingWorkflowClient) Object.defineProperty(client, 'workflow', { value: new TimeSkippingWorkflowClient({ connection: env.connection, namespace }) });
  return { namespace, client };
}

export async function temporalTestEnvironment(): Promise<TestWorkflowEnvironment> {
  const env = await clockSkippingEnvironment();
  Object.defineProperty(env, 'client', { value: new Client({ connection: env.connection, namespace: env.namespace ?? 'default' }) });
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
