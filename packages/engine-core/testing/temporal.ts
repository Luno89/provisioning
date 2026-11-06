import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, type WorkflowBundle } from '@temporalio/worker';
import { inject } from 'vitest';

export const temporal = (): Promise<TestWorkflowEnvironment> =>
  TestWorkflowEnvironment.createFromExistingServer({ address: inject('temporalAddress') });

let bundle: Promise<WorkflowBundle> | undefined;

export const workflowBundle = (): Promise<WorkflowBundle> => {
  bundle ??= bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)) });
  return bundle;
};

export const queueFor = (what: string): string => `${what}-${randomUUID()}`;
