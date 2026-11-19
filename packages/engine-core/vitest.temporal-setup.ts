import { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporalServerExecutable } from '@koala/engine-core/testing/shared';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    temporalAddress: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const env = await TestWorkflowEnvironment.createLocal({ server: { executable: temporalServerExecutable() } });
  project.provide('temporalAddress', env.address);
  return async () => {
    await env.teardown();
  };
}
