import { describe, it, expect } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../accounts/lib/account-removal.js';
import { mock } from 'vitest-mock-extended';
import { createAccountRemovalActivities, type AccountRemovalDeps } from '../activities/RemoveAccountActivities.js';
import type { DeploymentMetadata } from '../platform/lib/types.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { temporalTestEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile, uniqueName, testWorker } from './testing/test-worker.js';
import { fakeRemovalSteps, removingAccounts } from './testing/account-removal-steps.js';

const temporal = environmentForFile(temporalTestEnvironment);

describe('removing an account through Temporal', () => {
  it('fences the account, stops its workflows and deletes its repositories, then destroys its apps and deletes its workspaces, secrets, mesh and records, in that order', async () => {
    const seen: string[] = [];
    await removingAccounts(temporal.env, fakeRemovalSteps(seen), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('bo'), [{ ownerId: 'bo' }], 'bo');
      expect(await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('bo')).result()).toEqual({
        stoppedWorkflows: 0, apps: 0, secrets: 0, meshDevices: 1, repositories: true, records: { conversations: 3, users: 1 },
      });
      expect(await workflows.state(removeAccountWorkflowId('bo'))).toEqual({ state: 'finished' });
    });
    expect(seen).toEqual(['fence', 'workflows', 'repositories', 'apps', 'workspaces', 'secrets', 'mesh', 'records', 'fence ended']);
  });

  it('says how far it has got while it runs', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    let reached: () => void = () => undefined;
    const atMesh = new Promise<void>((done) => { reached = done; });
    await removingAccounts(temporal.env, fakeRemovalSteps([], { RemoveAccountMeshActivity: async () => { reached(); await held; return { devices: 0, user: false }; } }), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('cy'), [{ ownerId: 'cy' }], 'cy');
      await atMesh;
      expect(await workflows.state(removeAccountWorkflowId('cy'))).toEqual({ state: 'running', done: ['workflows', 'repositories', 'apps', 'workspaces', 'secrets'] });
      release();
      await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('cy')).result();
    });
  });

  it('reports a step that could not finish, with its reason', async () => {
    await removingAccounts(temporal.env, fakeRemovalSteps([], { RemoveAccountRepositoriesActivity: async () => { throw ApplicationFailure.nonRetryable('Gitea would not delete the user koala-dee (HTTP 500)'); } }), async (workflows) => {
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('dee'), [{ ownerId: 'dee' }], 'dee');
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
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId('eve'), [{ ownerId: 'eve' }], 'eve');
      expect(await temporal.env.client.workflow.getHandle(removeAccountWorkflowId('eve')).result()).toMatchObject({ apps: 1 });
    }));
    expect(destroyed).toEqual(['shop in shop-1a2b3c']);
    expect((await db.infrastructure.getDeployments()).find((dep) => dep.id === 'd1')?.temporalWorkflowId, 'the app names its destroy once that destroy has started').toBe(`app-destroy-shop-${clusterQueue}`);
    expect(seen.slice(0, 6)).toEqual(['fence', 'workflows', 'repositories', 'apps', 'destroyed', 'workspaces']);
  });

  it('knows nothing of an account that was never being removed', async () => {
    await removingAccounts(temporal.env, fakeRemovalSteps([]), async (workflows) => {
      expect(await workflows.state(removeAccountWorkflowId('nobody'))).toEqual({ state: 'none' });
    });
  });

});
