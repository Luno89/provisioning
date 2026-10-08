import { TestWorkflowEnvironment } from '@temporalio/testing';
import { OWNER_ATTRIBUTE } from '../lib/workflow-owner.js';
import { registerOwnerAttribute } from '../lib/temporal-client.js';

export const temporalTestEnvironment = (): Promise<TestWorkflowEnvironment> =>
  TestWorkflowEnvironment.createLocal({ server: { searchAttributes: [OWNER_ATTRIBUTE] } });

export async function timeSkippingTestEnvironment(): Promise<TestWorkflowEnvironment> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  await registerOwnerAttribute(env.connection, env.namespace ?? 'default');
  return env;
}
