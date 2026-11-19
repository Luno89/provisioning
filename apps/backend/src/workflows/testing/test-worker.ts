import { activityInterceptors, WORKER_DEFAULTS } from '@koala/engine-core';
import { Worker, type WorkerOptions } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import { bundled } from './temporal-test-env.js';

const workflowsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface FileEnvironment {
  readonly env: TestWorkflowEnvironment;
}

export function environmentForFile(make: () => Promise<TestWorkflowEnvironment>): FileEnvironment {
  let env: TestWorkflowEnvironment | undefined;
  beforeAll(async () => { env = await make(); });
  afterAll(async () => { await env?.teardown(); });
  return {
    get env() {
      if (!env) throw new Error('this file\'s Temporal environment is made in beforeAll; a test reached it before it was made');
      return env;
    },
  };
}

export const uniqueName = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export interface TestWorkerOptions {
  taskQueue: string;
  workflows?: string;
  workflowInterceptors?: string[];
  activityInterceptors?: NonNullable<WorkerOptions['interceptors']>['activity'];
  activities?: object;
}

export async function testWorker(env: TestWorkflowEnvironment, options: TestWorkerOptions): Promise<Worker> {
  const { taskQueue, workflows, workflowInterceptors = [], activities } = options;
  return Worker.create({
    ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue,
    interceptors: { activity: options.activityInterceptors ?? activityInterceptors() },
    ...(workflows ? { workflowBundle: await bundled(resolve(workflowsFolder, workflows), workflowInterceptors.map((module) => resolve(workflowsFolder, module))) } : {}),
    ...(activities ? { activities } : {}),
  });
}
