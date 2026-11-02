import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { TestProject } from 'vitest/node';
import { registerOwnerAttribute } from './src/platform/lib/temporal-client.js';
import { OWNER_ATTRIBUTE } from './src/platform/lib/workflow-owner.js';
import { TEST_NAMESPACES, testNamespace } from './src/workflows/temporal-test-env.js';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const names = Array.from({ length: TEST_NAMESPACES }, (_unused, index) => testNamespace(index + 1));
  const env = await TestWorkflowEnvironment.createLocal({
    server: { searchAttributes: [OWNER_ATTRIBUTE], extraArgs: names.flatMap((name) => ['--namespace', name]) },
  });
  await Promise.all(names.map((name) => registerOwnerAttribute(env.connection, name)));
  const claims = mkdtempSync(join(tmpdir(), 'koala-temporal-namespaces-'));
  project.provide('temporalAddress', env.address);
  project.provide('temporalClaims', claims);
  return async () => {
    await env.teardown();
    rmSync(claims, { recursive: true, force: true });
  };
}
