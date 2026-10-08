import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ApplicationFailure } from '@temporalio/common';
import type { ConcludeWorkspaceArgs } from '../engine-host/temporal/contracts.js';
import { WorkspaceConclusionService, WorkspaceNotConcludedError } from '../services/WorkspaceConclusionService.js';
import { temporalTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const withWorker = async (activity: (args: ConcludeWorkspaceArgs) => Promise<unknown>, body: (service: WorkspaceConclusionService) => Promise<void>) => {
  const taskQueue = `conclude-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname, 'ConcludeWorkspaceWorkflow.ts'),
    activities: { ConcludeWorkspaceActivity: activity },
  });
  await worker.runUntil(() => body(new WorkspaceConclusionService({ workflows: async () => env.client.workflow, taskQueue })));
};

describe('concluding a workspace through Temporal', () => {
  it('waits for the workspace to be saved and deleted, and answers with what was saved', async () => {
    const seen: ConcludeWorkspaceArgs[] = [];
    await withWorker(async (args) => { seen.push(args); return { saved: true, owner: 'koala-u1', repo: 'tree-t1', commit: 'c0ffee' }; }, async (service) => {
      expect(await service.conclude('u1', { kind: 'tree', id: 't1' })).toEqual({ saved: true, owner: 'koala-u1', repo: 'tree-t1', commit: 'c0ffee' });
    });
    expect(seen).toEqual([{ ownerId: 'u1', workspace: { kind: 'tree', id: 't1' } }]);
  }, 60_000);

  it('joins a conclusion already under way for the same workspace rather than running a second one', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    await withWorker(async () => { calls += 1; await held; return { saved: true, owner: 'koala-u1', repo: 'research-c1', commit: 'c0ffee' }; }, async (service) => {
      const first = service.conclude('u1', { kind: 'conversation', id: 'c1' });
      await new Promise((settle) => setTimeout(settle, 500));
      const second = service.conclude('u1', { kind: 'conversation', id: 'c1' });
      release();
      expect(await Promise.all([first, second])).toEqual([
        expect.objectContaining({ saved: true }),
        expect.objectContaining({ saved: true }),
      ]);
    });
    expect(calls).toBe(1);
  }, 60_000);

  it('refuses with why, as a conflict, when the workspace could not be saved', async () => {
    await withWorker(async () => { throw ApplicationFailure.nonRetryable('Pushing to koala-u1/research-c2 failed: Gitea is down'); }, async (service) => {
      const refused = await service.conclude('u1', { kind: 'conversation', id: 'c2' }).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(WorkspaceNotConcludedError);
      expect((refused as WorkspaceNotConcludedError).status).toBe(409);
      expect((refused as Error).message).toBe('the conversation\'s workspace could not be saved, so nothing was deleted: Pushing to koala-u1/research-c2 failed: Gitea is down');
    });
  }, 60_000);
});
