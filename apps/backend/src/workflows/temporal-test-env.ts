import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, type WorkflowBundle } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import Long from 'long';
import { inject } from 'vitest';
import { OWNER_ATTRIBUTE } from '../platform/lib/workflow-owner.js';
import { registerOwnerAttribute } from '../platform/lib/temporal-client.js';

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

export async function realTemporalEnvironment(): Promise<TestWorkflowEnvironment> {
  const address = inject('temporalAddress');
  if (!address) return TestWorkflowEnvironment.createLocal({ server: { searchAttributes: [OWNER_ATTRIBUTE] } });
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
