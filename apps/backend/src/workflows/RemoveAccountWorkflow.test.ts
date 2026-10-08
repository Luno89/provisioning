import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../lib/account-removal.js';
import { temporalRemovalWorkflows } from '../services/AccountRemovalService.js';
import type { AccountRemovalActivities } from '../activities/RemoveAccountActivities.js';
import { temporalTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const fakeSteps = (seen: string[], over: Partial<AccountRemovalActivities> = {}): AccountRemovalActivities => ({
  RemoveAccountWorkflowsActivity: async () => { seen.push('workflows'); return 0; },
  RemoveAccountKeepRunsActivity: async ({ keepRunsFor }) => { seen.push(`keep for ${keepRunsFor}`); return 3; },
  RemoveAccountWorkspacesActivity: async () => { seen.push('workspaces'); return 'deleted'; },
  RemoveAccountSecretsActivity: async () => { seen.push('secrets'); return 0; },
  RemoveAccountMeshActivity: async () => { seen.push('mesh'); return { devices: 1, user: true }; },
  RemoveAccountRepositoriesActivity: async () => { seen.push('repositories'); return true; },
  RemoveAccountRecordsActivity: async () => { seen.push('records'); return { conversations: 3, users: 1 }; },
  ...over,
});

const withWorker = async (activities: AccountRemovalActivities, body: (workflows: ReturnType<typeof temporalRemovalWorkflows>) => Promise<void>) => {
  const taskQueue = `remove-account-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname, 'RemoveAccountWorkflow.ts'),
    activities,
  });
  await worker.runUntil(() => body(temporalRemovalWorkflows(() => env.client, taskQueue)));
};

const until = async <T>(probe: () => Promise<T | undefined>): Promise<T> => {
  for (let tries = 0; tries < 100; tries += 1) {
    const found = await probe();
    if (found !== undefined) return found;
    await new Promise((settle) => setTimeout(settle, 100));
  }
  throw new Error('timed out');
};

describe('removing an account through Temporal', () => {
  it('stops its workflows, then deletes its workspaces, secrets, mesh, repositories and records, in that order', async () => {
    const seen: string[] = [];
    await withWorker(fakeSteps(seen), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('bo'), [{ ownerId: 'bo' }], 'bo');
      expect(await env.client.workflow.getHandle(removeAccountWorkflowId('bo')).result()).toEqual({
        stoppedWorkflows: 0, secrets: 0, meshDevices: 1, repositories: true, records: { conversations: 3, users: 1 },
      });
      expect(await workflows.state(removeAccountWorkflowId('bo'))).toEqual({ state: 'finished' });
    });
    expect(seen).toEqual(['workflows', 'workspaces', 'secrets', 'mesh', 'repositories', 'records']);
  }, 60_000);

  it('says how far it has got while it runs', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    await withWorker(fakeSteps([], { RemoveAccountMeshActivity: async () => { await held; return { devices: 0, user: false }; } }), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('cy'), [{ ownerId: 'cy' }], 'cy');
      const midway = await until(async () => {
        const state = await workflows.state(removeAccountWorkflowId('cy'));
        return state.state === 'running' && state.done.length === 3 ? state : undefined;
      });
      expect(midway).toEqual({ state: 'running', done: ['workflows', 'workspaces', 'secrets'] });
      release();
      await env.client.workflow.getHandle(removeAccountWorkflowId('cy')).result();
    });
  }, 60_000);

  it('reports a step that could not finish, with its reason', async () => {
    await withWorker(fakeSteps([], { RemoveAccountRepositoriesActivity: async () => { throw ApplicationFailure.nonRetryable('Gitea would not delete the user koala-dee (HTTP 500)'); } }), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('dee'), [{ ownerId: 'dee' }], 'dee');
      await env.client.workflow.getHandle(removeAccountWorkflowId('dee')).result().catch(() => undefined);
      expect(await workflows.state(removeAccountWorkflowId('dee'))).toEqual({ state: 'failed', reason: 'Gitea would not delete the user koala-dee (HTTP 500)' });
    });
  }, 60_000);

  it('knows nothing of an account that was never being removed', async () => {
    await withWorker(fakeSteps([]), async (workflows) => {
      expect(await workflows.state(removeAccountWorkflowId('nobody'))).toEqual({ state: 'none' });
    });
  }, 60_000);

});
