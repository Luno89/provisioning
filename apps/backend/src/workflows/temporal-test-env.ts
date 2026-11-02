import { TestWorkflowEnvironment } from '@temporalio/testing';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from 'vitest';
import { OWNER_ATTRIBUTE } from '../platform/lib/workflow-owner.js';
import { registerOwnerAttribute } from '../platform/lib/temporal-client.js';

declare module 'vitest' {
  export interface ProvidedContext {
    temporalAddress: string;
    temporalClaims: string;
  }
}

export const TEST_NAMESPACES = 64;
export const testNamespace = (index: number): string => `koala-test-${index}`;

function claimNamespace(claims: string): string {
  for (let index = 1; index <= TEST_NAMESPACES; index += 1) {
    try {
      mkdirSync(join(claims, String(index)));
      return testNamespace(index);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`every one of the ${TEST_NAMESPACES} Temporal test namespaces is taken; raise TEST_NAMESPACES`);
}

export function temporalTestEnvironment(): Promise<TestWorkflowEnvironment> {
  const address = inject('temporalAddress');
  if (!address) return TestWorkflowEnvironment.createLocal({ server: { searchAttributes: [OWNER_ATTRIBUTE] } });
  return TestWorkflowEnvironment.createFromExistingServer({ address, namespace: claimNamespace(inject('temporalClaims')) });
}

export async function timeSkippingTestEnvironment(): Promise<TestWorkflowEnvironment> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  await registerOwnerAttribute(env.connection, env.namespace ?? 'default');
  return env;
}
