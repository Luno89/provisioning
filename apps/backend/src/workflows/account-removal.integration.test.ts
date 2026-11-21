import { Context } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { testClient } from '@koala/engine-core/testing/temporal';
import { withWorkFor } from '@koala/engine-core/work-for';
import { DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../accounts/lib/account-removal.js';
import { temporalRemovalWorkflows } from '../accounts/services/AccountRemovalService.js';
import { createAccountRemovalActivities, NO_MESH_HERE, temporalAccountProjects, type AccountRemovalDeps } from '../activities/RemoveAccountActivities.js';
import { namesItsWork } from '../platform/lib/temporal-client.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { uniqueName } from './testing/test-worker.js';
import { fakeApps, quietKube, removalWorkers, removalWorld } from './testing/removal-world.js';
import type { AccountRemoved } from './DeleteAccountWorkflow.js';

const world = removalWorld();
const at = '2026-11-21T10:00:00.000Z';

describe('an account being removed while a step of its run is still writing', () => {
  it('cancels the step, waits until it has really stopped, so what it wrote on its way out goes with the account, deletes its project in Deleted projects for good, and waits on no timer', async () => {
    const { db } = world;
    const owner = uniqueName('leaving');
    const kept = `${owner}-kept`;
    await db.accounts.saveUser({ id: owner, email: `${owner}@example.com`, twoFactorEnabled: false, emailVerified: true, removal: { startedAt: at, requestedBy: owner }, createdAt: at });
    await db.projects.saveProject({ id: kept, name: 'kept', ownerId: owner, appType: 'gitapp', createdAt: at });
    await db.projects.markDeleting(kept, { startedAt: at, requestedBy: owner, mode: 'archive' });
    await db.projects.archive(kept);

    const client = testClient(world.env, { interceptors: { workflow: [namesItsWork] } });
    const queue = uniqueName('removing');
    let started!: () => void;
    const running = new Promise<void>((done) => { started = done; });
    const { workers } = await removalWorkers(world, client, queue, {
      workflows: 'testing/removals.fixture-workflow.ts',
      activities: (work) => createAccountRemovalActivities({
        ...mock<AccountRemovalDeps>(),
        store: db,
        apps: fakeApps,
        work,
        projects: temporalAccountProjects(async () => client, queue),
        kube: quietKube(),
        repositories: { deleteUser: async () => false },
        secrets: { removeProject: async () => ({ workspace: false, readers: 0 }) },
        mesh: NO_MESH_HERE,
        files: { removeOwned: async () => 0 },
      }),
      step: async ({ ownerId }) => {
        const stop = Context.current().cancellationSignal;
        started();
        await new Promise<void>((stopped) => stop.addEventListener('abort', () => stopped(), { once: true }));
        await db.engine.saveConversation({ id: `${ownerId}-late`, ownerId, title: 'late', messages: [], createdAt: at, updatedAt: at } as never);
        throw stop.reason;
      },
      told: [],
    });
    const runs = workers.map((worker) => worker.run());
    try {
      await client.workflow.start('ProjectStepWorkflow', { taskQueue: `${queue}-step`, workflowId: `step-${owner}`, args: [{ ownerId: owner, projectId: '' }], ...startedFor(owner) });
      await running;
      const workflows = temporalRemovalWorkflows<{ ownerId: string }>(() => client, queue);
      await withWorkFor({ owner, removing: 'owner' }, () => workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId(owner), [{ ownerId: owner }], owner));
      const handle = client.workflow.getHandle(removeAccountWorkflowId(owner));
      const result = (await handle.result()) as AccountRemoved;
      expect(result).toMatchObject({ stopped: [`step-${owner}`], projects: [kept] });
      expect(((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes), 'removal waits on no timer').toBe(false);
      expect(await db.engine.getConversation(owner, `${owner}-late`), 'what the step wrote on its way out is gone with the account').toBeUndefined();
      expect((await db.projects.getProjects()).some((project) => project.id === kept), 'the project in Deleted projects is deleted for good').toBe(false);
      expect(await db.accounts.accountLeftovers(owner)).toEqual({});
    } finally {
      for (const worker of workers) worker.shutdown();
      await Promise.all(runs);
    }
  });
});
