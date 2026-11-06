import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    temporalAddress: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const env = await TestWorkflowEnvironment.createLocal();
  project.provide('temporalAddress', env.address);
  return async () => {
    await env.teardown();
  };
}
