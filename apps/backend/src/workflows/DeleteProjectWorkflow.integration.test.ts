import { describe, it, expect } from 'vitest';
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
    const activities: ProjectDeletionActivities = {
      StopProjectWorkActivity: async () => { seen.push('stop'); return ['run-1', 'build-1']; },
      RemoveProjectAppsActivity: async () => { seen.push('apps'); return []; },
      RemoveProjectAppStartedActivity: async () => undefined,
      RemoveProjectWorkspacesActivity: async () => { seen.push('workspaces'); return 1; },
      RemoveProjectSecretsActivity: async () => { seen.push('secrets'); return { workspace: true, readers: 0 }; },
      SweepProjectActivity: async () => {
        passes += 1;
        seen.push(`sweep ${passes}`);
        return passes === 1 ? { open: ['late-run'], apps: 0, deleted: 1 } : { open: [], apps: 0, deleted: 0 };
      },
      ...deletedForGood(seen),
    };
    const taskQueue = uniqueName('delete-project-test');
    const worker = await testWorker(temporal.env, { taskQueue, workflows: 'DeleteProjectWorkflow.ts', activities });
    const clusterWorker = await testWorker(temporal.env, {
      taskQueue: QUEUES.cluster,
      activities: { AwaitProjectWorkActivity: async ({ workflowIds }: { workflowIds: string[] }) => { seen.push(`await ${workflowIds.join(' ')}`); return { restarted: workflowIds.includes('run-1') ? ['worker-engine-7d9f'] : [] }; } },
    });
    const { worker: streamWorker, told } = await groveTold(temporal.env);

    await clusterWorker.runUntil(streamWorker.runUntil(worker.runUntil(async () => {
      const workflows = temporalRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>(() => temporal.env.client, taskQueue, PROJECT_REMOVAL_PROGRESS_QUERY);
      await workflows.start(DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId('p1'), [{ projectId: 'p1' }], 'bo');
      expect(await temporal.env.client.workflow.getHandle(deleteProjectWorkflowId('p1')).result()).toMatchObject({
        stopped: ['run-1', 'build-1', 'late-run'], restarted: ['worker-engine-7d9f'], sweeps: 2, repositories: ['koala-bo/shop'], files: 2, records: { projects: 1 },
      });
      expect(await workflows.state(deleteProjectWorkflowId('p1'))).toEqual({ state: 'finished' });
    })));
    expect(seen).toEqual([
      'stop', 'await run-1 build-1', 'apps', 'workspaces', 'secrets',
      'sweep 1', 'await late-run', 'sweep 2',
      'repositories', 'files', 'records',
    ]);
    expect(told).toEqual(['bo']);
  });
});
