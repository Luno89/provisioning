import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ACTIVITY_STOP_GRACE_MS, REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../lib/account-removal.js';
import { temporalRemovalWorkflows } from '../services/AccountRemovalService.js';
import type { AccountRemovalActivities } from '../activities/RemoveAccountActivities.js';
import { timeSkippingTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await timeSkippingTestEnvironment();
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


describe('removing an account that still had something running', () => {
  it('waits for the activities of what it stopped to wind down, then hands the runs over, before anything is deleted', async () => {
    const seen: string[] = [];
    await withWorker(fakeSteps(seen, { RemoveAccountWorkflowsActivity: async () => { seen.push('workflows'); return 2; } }), async (workflows) => {
      const started = Date.now();
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('space-1'), [{ ownerId: 'space-1', keepRunsFor: 'bo' }], 'space-1');
      const handle = env.client.workflow.getHandle(removeAccountWorkflowId('space-1'));
      await handle.result();
      const history = await handle.fetchHistory();
      const timers = (history.events ?? []).filter((event) => event.timerStartedEventAttributes);
      expect(timers.map((event) => Number(event.timerStartedEventAttributes!.startToFireTimeout!.seconds))).toEqual([ACTIVITY_STOP_GRACE_MS / 1000]);
      expect(Date.now() - started).toBeLessThan(ACTIVITY_STOP_GRACE_MS);
    });
    expect(seen).toEqual(['workflows', 'keep for bo', 'workspaces', 'secrets', 'mesh', 'repositories', 'records']);
  });

  it('does not wait when nothing was running, and keeps no runs unless asked', async () => {
    const seen: string[] = [];
    await withWorker(fakeSteps(seen, { RemoveAccountWorkflowsActivity: async () => { seen.push('workflows'); return 0; } }), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('grace-cy'), [{ ownerId: 'grace-cy' }], 'grace-cy');
      const handle = env.client.workflow.getHandle(removeAccountWorkflowId('grace-cy'));
      await handle.result();
      expect(((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes)).toBe(false);
    });
    expect(seen).toEqual(['workflows', 'workspaces', 'secrets', 'mesh', 'repositories', 'records']);
  });
});
