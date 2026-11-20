import type { Worker } from '@temporalio/worker';
import { testWorker as koalaTestWorker, type TestTemporal, type TestWorkerOptions as KoalaTestWorkerOptions } from '@koala/engine-core/testing/temporal';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import { bundled } from './temporal-test-env.js';

const workflowsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface FileEnvironment {
  readonly env: TestTemporal;
}

export function environmentForFile(make: () => Promise<TestTemporal>): FileEnvironment {
  let env: TestTemporal | undefined;
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

export type TestWorkerOptions = KoalaTestWorkerOptions & {
  workflows?: string;
  workflowInterceptors?: string[];
};

export async function testWorker(env: TestTemporal, options: TestWorkerOptions): Promise<Worker> {
  const { workflows, workflowInterceptors = [], ...rest } = options;
  return koalaTestWorker(env, {
    ...rest,
    ...(workflows ? { workflowBundle: await bundled(resolve(workflowsFolder, workflows), workflowInterceptors.map((module) => resolve(workflowsFolder, module))) } : {}),
  });
}
