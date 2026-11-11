import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { TestProject } from 'vitest/node';
import { OWNER_ATTRIBUTE } from './src/platform/lib/workflow-owner.js';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const env = await TestWorkflowEnvironment.createLocal({
    server: { searchAttributes: [OWNER_ATTRIBUTE] },
  });
  project.provide('temporalAddress', env.address);
  return async () => {
    await env.teardown();
  };
}
