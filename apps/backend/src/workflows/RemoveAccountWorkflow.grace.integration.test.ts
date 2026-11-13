import { activityInterceptors } from '@koala/engine-core';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../accounts/lib/account-removal.js';
import { temporalRemovalWorkflows } from '../accounts/services/AccountRemovalService.js';
import type { AccountRemovalActivities } from '../activities/RemoveAccountActivities.js';
import { bundled, realTemporalEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await realTemporalEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const fakeSteps = (seen: string[], over: Partial<AccountRemovalActivities> = {}): AccountRemovalActivities => ({
  RemoveAccountFenceActivity: async () => { seen.push('fence'); return ['engine-1']; },
  RemoveAccountFenceEndActivity: async () => { seen.push('fence ended'); return []; },
  RemoveAccountWorkflowsActivity: async () => { seen.push('workflows'); return 0; },
  RemoveAccountKeepRunsActivity: async ({ keepRunsFor }) => { seen.push(`keep for ${keepRunsFor}`); return 3; },
  RemoveAccountAppsActivity: async () => { seen.push('apps'); return []; },
  RemoveAccountAppStartedActivity: async () => undefined,
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
    interceptors: { activity: activityInterceptors() },
    ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
    taskQueue,
    workflowBundle: await bundled(resolve(__dirname, 'RemoveAccountWorkflow.ts')),
    activities,
  });
  await worker.runUntil(() => body(temporalRemovalWorkflows(() => env.client, taskQueue)));
};

describe('removing an account that still had something running', () => {
  it('waits on no timer: it fences the account first, then stops its runs, deletes its repositories and hands its runs over, before anything else is deleted', async () => {
    const seen: string[] = [];
    await withWorker(fakeSteps(seen, { RemoveAccountWorkflowsActivity: async () => { seen.push('workflows'); return 2; } }), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('space-1'), [{ ownerId: 'space-1', keepRunsFor: 'bo' }], 'space-1');
      const handle = env.client.workflow.getHandle(removeAccountWorkflowId('space-1'));
      await handle.result();
      expect(((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes)).toBe(false);
    });
    expect(seen).toEqual(['fence', 'workflows', 'repositories', 'keep for bo', 'apps', 'workspaces', 'secrets', 'mesh', 'records', 'fence ended']);
  });

  it('keeps no runs unless asked', async () => {
    const seen: string[] = [];
    await withWorker(fakeSteps(seen), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('grace-cy'), [{ ownerId: 'grace-cy' }], 'grace-cy');
      await env.client.workflow.getHandle(removeAccountWorkflowId('grace-cy')).result();
    });
    expect(seen).toEqual(['fence', 'workflows', 'repositories', 'apps', 'workspaces', 'secrets', 'mesh', 'records', 'fence ended']);
  });
});
