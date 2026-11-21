import { describe, it, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createProjectRemovalActivities, type ProjectRemovalDeps } from '../activities/RemoveProjectActivities.js';
import type { DeploymentMetadata } from '../platform/lib/types.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId, PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import { temporalRemovalWorkflows } from '../accounts/services/AccountRemovalService.js';
import type { ProjectDeletionActivities } from '../activities/DeleteProjectActivities.js';
import { QUEUES } from '../platform/lib/work-places.js';
import { temporalTestEnvironment } from './testing/temporal-test-env.js';
import { deletedForGood, groveTold } from './testing/removal-steps.js';
import { environmentForFile, uniqueName, testWorker } from './testing/test-worker.js';

const temporal = environmentForFile(temporalTestEnvironment);

describe('deleting a project for good through Temporal', () => {
  it('stops its work, waits for it to close, deletes what runs, and sweeps until a pass finds nothing before deleting its code, files and records', async () => {
    const seen: string[] = [];
    let passes = 0;
    const appsQueue = uniqueName('delete-project-apps');
    const appsWorker = await testWorker(temporal.env, {
      taskQueue: appsQueue,
      workflows: 'DestroyAppWorkflow.ts',
      activities: { DestroyAppActivity: async (args: { name: string; namespace?: string }) => { seen.push(`destroy ${args.name} in ${args.namespace}`); return { status: 'destroyed', msg: '' }; } },
    });
    const db = await testDatabase();
    await db.infrastructure.saveDeployment({ id: 'd1', name: 'shop', clusterId: 'c', strategy: 'helm', status: 'destroying', ownerId: 'bo', temporalWorkflowId: '' } as DeploymentMetadata);
    const real = createProjectRemovalActivities({ ...mock<ProjectRemovalDeps>(), store: db });
    let appsAsked = 0;
    const activities: ProjectDeletionActivities = {
      StopProjectWorkActivity: async () => { seen.push('stop'); return ['run-1', 'build-1']; },
      RemoveProjectAppsActivity: async () => {
        seen.push('apps');
        appsAsked += 1;
        return appsAsked > 1 ? [] : [{ deploymentId: 'd1', workflowId: `app-destroy-shop-${appsQueue}`, taskQueue: appsQueue, args: { name: 'shop', clusterId: 'c', clusterName: 'system', provider: 'k3d', strategy: 'helm', logFile: '/tmp/x.log', appType: 'odoo-project', namespace: 'shop-1a2b3c', reach: { clusterId: 'c', kind: 'koala' as const } } }];
      },
      RemoveProjectAppStartedActivity: real.RemoveProjectAppStartedActivity,
      RemoveProjectWorkspacesActivity: async () => { seen.push('workspaces'); return 1; },
      RemoveProjectSecretsActivity: async () => { seen.push('secrets'); return { workspace: true, readers: 0 }; },
      SweepProjectActivity: async () => {
        passes += 1;
        seen.push(`sweep ${passes}`);
        return passes === 1 ? { open: ['late-run'], apps: 0, deleted: 1 } : { open: [], apps: 0, deleted: 0 };
      },
      ...deletedForGood(seen),
      ArchiveProjectActivity: async () => { seen.push('archived'); },
    };
    const taskQueue = uniqueName('delete-project-test');
    const worker = await testWorker(temporal.env, { taskQueue, workflows: 'DeleteProjectWorkflow.ts', activities });
    const clusterWorker = await testWorker(temporal.env, {
      taskQueue: QUEUES.cluster,
      activities: { AwaitProjectWorkActivity: async ({ workflowIds }: { workflowIds: string[] }) => { seen.push(`await ${workflowIds.join(' ')}`); return { restarted: workflowIds.includes('run-1') ? ['worker-engine-7d9f'] : [] }; } },
    });
    const { worker: streamWorker, told } = await groveTold(temporal.env);

    await appsWorker.runUntil(clusterWorker.runUntil(streamWorker.runUntil(worker.runUntil(async () => {
      const workflows = temporalRemovalWorkflows<{ projectId: string; mode: 'archive' | 'permanent' }, ProjectRemovalStep>(() => temporal.env.client, taskQueue, PROJECT_REMOVAL_PROGRESS_QUERY);
      await workflows.start(DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId('p1'), [{ projectId: 'p1', mode: 'permanent' }], 'bo');
      expect(await temporal.env.client.workflow.getHandle(deleteProjectWorkflowId('p1')).result()).toMatchObject({
        stopped: ['run-1', 'build-1', 'late-run'], restarted: ['worker-engine-7d9f'], sweeps: 2, repositories: ['koala-bo/shop'], files: 2, records: { projects: 1 },
      });
      expect(await workflows.state(deleteProjectWorkflowId('p1'))).toEqual({ state: 'finished' });
    }))));
    expect(seen).toEqual([
      'stop', 'await run-1 build-1', 'apps', 'destroy shop in shop-1a2b3c', 'workspaces', 'secrets',
      'sweep 1', 'await late-run', 'sweep 2',
      'repositories', 'files', 'records',
    ]);
    expect(told).toEqual(['bo']);
    expect((await db.infrastructure.getDeployments()).find((dep) => dep.id === 'd1')?.temporalWorkflowId, 'the app names its destroy once that destroy has started').toBe(`app-destroy-shop-${appsQueue}`);
  });

  it('keeps what can be restored when asked to: stops and deletes what runs, sweeps, then archives it and deletes nothing for good', async () => {
    const seen: string[] = [];
    const activities: ProjectDeletionActivities = {
      StopProjectWorkActivity: async () => { seen.push('stop'); return []; },
      RemoveProjectAppsActivity: async () => { seen.push('apps'); return []; },
      RemoveProjectAppStartedActivity: async () => undefined,
      RemoveProjectWorkspacesActivity: async () => { seen.push('workspaces'); return 0; },
      RemoveProjectSecretsActivity: async () => { seen.push('secrets'); return { workspace: false, readers: 0 }; },
      SweepProjectActivity: async () => { seen.push('sweep'); return { open: [], apps: 0, deleted: 0 }; },
      ...deletedForGood(seen),
      ArchiveProjectActivity: async () => { seen.push('archived'); },
    };
    const taskQueue = uniqueName('archive-project-test');
    const worker = await testWorker(temporal.env, { taskQueue, workflows: 'DeleteProjectWorkflow.ts', activities });
    const clusterWorker = await testWorker(temporal.env, { taskQueue: QUEUES.cluster, activities: { AwaitProjectWorkActivity: async () => ({ restarted: [] }) } });
    const { worker: streamWorker } = await groveTold(temporal.env);
    await clusterWorker.runUntil(streamWorker.runUntil(worker.runUntil(async () => {
      const workflows = temporalRemovalWorkflows<{ projectId: string; mode: 'archive' | 'permanent' }, ProjectRemovalStep>(() => temporal.env.client, taskQueue, PROJECT_REMOVAL_PROGRESS_QUERY);
      await workflows.start(DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId('p2'), [{ projectId: 'p2', mode: 'archive' }], 'bo');
      expect(await temporal.env.client.workflow.getHandle(deleteProjectWorkflowId('p2')).result()).toMatchObject({ archived: true, repositories: [], files: 0, records: {} });
    })));
    expect(seen).toEqual(['stop', 'apps', 'workspaces', 'secrets', 'sweep', 'archived']);
  });
});
