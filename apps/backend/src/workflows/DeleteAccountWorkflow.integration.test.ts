import { describe, it, expect } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../accounts/lib/account-removal.js';
import { mock } from 'vitest-mock-extended';
import { createAccountRemovalActivities, type AccountRemovalDeps } from '../activities/RemoveAccountActivities.js';
import type { DeploymentMetadata } from '../platform/lib/types.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { temporalTestEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile, uniqueName, testWorker } from './testing/test-worker.js';
import { fakeRemovalSteps, nothingFrozen, removingAccounts } from './testing/account-removal-steps.js';
import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import type { AccountDeletionChange } from '../accounts/lib/account-removal.js';

const temporal = environmentForFile(temporalTestEnvironment);

describe('removing an account through Temporal', () => {
  it('marks the account, stops its workflows, deletes its projects for good and its repositories, then destroys its apps, deletes its workspaces and secrets, looks again for work, and deletes its mesh and records, in that order', async () => {
    const seen: string[] = [];
    await removingAccounts(temporal.env, fakeRemovalSteps(seen), async (workflows) => {
      await workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('bo'), [{ ownerId: 'bo' }], 'bo');
      expect(await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('bo')).result()).toEqual({
        stopped: [], projects: [], apps: 0, secrets: 0, meshDevices: 1, repositories: true, records: { conversations: 3, users: 1 },
      });
      expect(await workflows.state(removeAccountWorkflowId('bo'))).toEqual({ state: 'finished' });
    });
    expect(seen).toEqual(['mark', 'workflows', 'projects', 'repositories', 'apps', 'workspaces', 'secrets', 'workflows', 'mesh', 'records']);
  });

  it('waits for each workflow it stopped to close, then deletes each project for good, before anything else goes, and sweeps until a pass finds no work', async () => {
    const seen: string[] = [];
    let passes = 0;
    const work = (workflowId: string) => ({ workflowId, type: 'AgentRunWorkflow', startedAt: '2026-11-21T10:00:00.000Z' });
    await removingAccounts(temporal.env, fakeRemovalSteps(seen, {
      StopAccountWorkActivity: async () => {
        passes += 1;
        seen.push(`stop ${passes}`);
        return passes === 1 ? [work('run-1')] : passes === 2 ? [work('late-run')] : [];
      },
      RemoveAccountProjectsActivity: async () => { seen.push('projects'); return ['shop', 'kept']; },
    }), async (workflows) => {
      await workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('fay'), [{ ownerId: 'fay' }], 'fay');
      expect(await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('fay')).result()).toMatchObject({ stopped: ['run-1', 'late-run'], projects: ['shop', 'kept'] });
    }, nothingFrozen(seen));
    expect(seen).toEqual([
      'mark', 'stop 1', 'await run-1', 'projects', 'project shop', 'project kept', 'repositories', 'apps', 'workspaces', 'secrets',
      'stop 2', 'await late-run', 'apps', 'workspaces', 'stop 3', 'mesh', 'records',
    ]);
  });

  it('says how far it has got while it runs', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    let reached: () => void = () => undefined;
    const atMesh = new Promise<void>((done) => { reached = done; });
    await removingAccounts(temporal.env, fakeRemovalSteps([], { RemoveAccountMeshActivity: async () => { reached(); await held; return { devices: 0, user: false }; } }), async (workflows) => {
      await workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('cy'), [{ ownerId: 'cy' }], 'cy');
      await atMesh;
      expect(await workflows.state(removeAccountWorkflowId('cy'))).toEqual({ state: 'running', done: ['workflows', 'projects', 'repositories', 'apps', 'workspaces', 'secrets'] });
      release();
      await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('cy')).result();
    });
  });

  it('reports a step that could not finish, with its reason', async () => {
    await removingAccounts(temporal.env, fakeRemovalSteps([], { RemoveAccountRepositoriesActivity: async () => { throw ApplicationFailure.nonRetryable('Gitea would not delete the user koala-dee (HTTP 500)'); } }), async (workflows) => {
      await workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('dee'), [{ ownerId: 'dee' }], 'dee');
      await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('dee')).result().catch(() => undefined);
      expect(await workflows.state(removeAccountWorkflowId('dee'))).toEqual({ state: 'failed', reason: 'Gitea would not delete the user koala-dee (HTTP 500)' });
    });
  });

  it('destroys each of its apps on the cluster worker before it deletes its workspaces and records', async () => {
    const seen: string[] = [];
    const clusterQueue = uniqueName('remove-account-apps');
    const destroyed: string[] = [];
    const db = await testDatabase();
    await db.infrastructure.saveDeployment({ id: 'd1', name: 'shop', clusterId: 'c', strategy: 'helm', status: 'destroying', ownerId: 'eve', temporalWorkflowId: '' } as DeploymentMetadata);
    const real = createAccountRemovalActivities({ ...mock<AccountRemovalDeps>(), store: db });
    const clusterWorker = await testWorker(temporal.env, {
      taskQueue: clusterQueue,
      workflows: 'DestroyAppWorkflow.ts',
      activities: { DestroyAppActivity: async (args: { name: string; namespace?: string }) => { destroyed.push(`${args.name} in ${args.namespace}`); seen.push('destroyed'); return { status: 'destroyed', msg: '' }; } },
    });
    const app = { name: 'shop', clusterId: 'c', clusterName: 'system', provider: 'k3d', strategy: 'helm', logFile: '/tmp/x.log', appType: 'odoo-project', namespace: 'shop-1a2b3c', reach: { clusterId: 'c', kind: 'koala' as const } };
    await clusterWorker.runUntil(removingAccounts(temporal.env, fakeRemovalSteps(seen, {
      RemoveAccountAppsActivity: async () => { seen.push('apps'); return [{ deploymentId: 'd1', workflowId: `app-destroy-shop-${clusterQueue}`, taskQueue: clusterQueue, args: app }]; },
      RemoveAccountAppStartedActivity: real.RemoveAccountAppStartedActivity,
    }), async (workflows) => {
      await workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('eve'), [{ ownerId: 'eve' }], 'eve');
      expect(await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('eve')).result()).toMatchObject({ apps: 1 });
    }));
    expect(destroyed).toEqual(['shop in shop-1a2b3c']);
    expect((await db.infrastructure.getDeployments()).find((dep) => dep.id === 'd1')?.temporalWorkflowId, 'the app names its destroy once that destroy has started').toBe(`app-destroy-shop-${clusterQueue}`);
    expect(seen.slice(0, 7)).toEqual(['mark', 'workflows', 'projects', 'repositories', 'apps', 'destroyed', 'workspaces']);
  });

  it('tells root, when root asked for it, each run it stops with its real state, each thing it deletes, and that the owner is deleted only at the end', async () => {
    const told: AccountDeletionChange[] = [];
    const stream = await testWorker(temporal.env, { taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities: { AccountDeletionChangedActivity: async (change: AccountDeletionChange) => { told.push(change); } } });
    let stops = 0;
    await stream.runUntil(removingAccounts(temporal.env, fakeRemovalSteps([], {
      StopAccountWorkActivity: async () => { stops += 1; return stops === 1 ? [{ workflowId: 'run-1', type: 'AgentRunWorkflow', startedAt: '2026-11-21T10:00:00.000Z' }] : []; },
      RemoveAccountProjectsActivity: async () => ['shop'],
      RemoveAccountSecretsActivity: async () => 2,
    }), async (workflows) => {
      await workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('hal'), [{ ownerId: 'hal', toRoot: true }], 'hal');
      await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('hal')).result();
    }, { AwaitProjectWorkActivity: async () => ({ frozen: [], killed: ['terraform'] }), RestartWorkerActivity: async () => 'restarted' }));
    const states = told.map((change) => change.progress);
    expect(told.every((change) => change.ownerId === 'hal')).toBe(true);
    expect(states.some((progress) => progress.work.some((work) => work.workflowId === 'run-1' && work.state === 'stopping'))).toBe(true);
    const last = [...states].sort((a, b) => b.seq - a.seq)[0]!;
    expect(last.phase).toBe('deleted');
    expect(last.work).toEqual([expect.objectContaining({ workflowId: 'run-1', state: 'stopped', killed: ['terraform'] })]);
    expect(last.parts).toMatchObject({ projects: { state: 'deleted', deleted: 1 }, secrets: { state: 'deleted', deleted: 2 }, records: { state: 'deleted', deleted: 4 } });
    expect(states.filter((progress) => progress.phase === 'deleted')).toHaveLength(1);
  });

  it('tells nobody when it was not asked to tell root', async () => {
    const told: AccountDeletionChange[] = [];
    const stream = await testWorker(temporal.env, { taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities: { AccountDeletionChangedActivity: async (change: AccountDeletionChange) => { told.push(change); } } });
    await stream.runUntil(removingAccounts(temporal.env, fakeRemovalSteps([]), async (workflows) => {
      await workflows.start(DELETE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('ike'), [{ ownerId: 'ike' }], 'ike');
      await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('ike')).result();
    }));
    expect(told).toEqual([]);
  });

  it('knows nothing of an account that was never being removed', async () => {
    await removingAccounts(temporal.env, fakeRemovalSteps([]), async (workflows) => {
      expect(await workflows.state(removeAccountWorkflowId('nobody'))).toEqual({ state: 'none' });
    });
  });

});
