import { describe, it, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ApplicationFailure } from '@temporalio/common';
import { createProjectRemovalActivities, type ProjectRemovalDeps } from '../activities/RemoveProjectActivities.js';
import type { DeploymentMetadata } from '../platform/lib/types.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId, PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import { temporalRemovalWorkflows } from '../accounts/services/AccountRemovalService.js';
import { deletionToldThrough, tellingWhenDown, type ProjectDeletionActivities } from '../activities/DeleteProjectActivities.js';
import { DependencyDownError } from '../platform/index.js';
import { QUEUES } from '../platform/lib/work-places.js';
import { temporalTestEnvironment } from './testing/temporal-test-env.js';
import { deletedForGood, groveTold, latest } from './testing/removal-steps.js';
import { environmentForFile, uniqueName, testWorker } from './testing/test-worker.js';

const temporal = environmentForFile(temporalTestEnvironment);

const work = (workflowId: string, type = 'AgentRunWorkflow') => ({ workflowId, type, startedAt: '2026-11-21T10:00:00.000Z' });

const nothingFrozen = { AwaitProjectWorkActivity: async () => ({ frozen: [] }), RestartWorkerActivity: async () => 'restarted' as const };

async function deleting(activities: ProjectDeletionActivities, projectId: string, mode: 'archive' | 'permanent', ending: (ended: Promise<unknown>) => Promise<void>) {
  const taskQueue = uniqueName(`delete-${projectId}-test`);
  const worker = await testWorker(temporal.env, { taskQueue, workflows: 'DeleteProjectWorkflow.ts', activities });
  const clusterWorker = await testWorker(temporal.env, { taskQueue: QUEUES.cluster, activities: nothingFrozen });
  const { worker: streamWorker, deletions } = await groveTold(temporal.env);
  await clusterWorker.runUntil(streamWorker.runUntil(worker.runUntil(async () => {
    const workflows = temporalRemovalWorkflows<{ projectId: string; mode: 'archive' | 'permanent' }, ProjectRemovalStep>(() => temporal.env.client, taskQueue, PROJECT_REMOVAL_PROGRESS_QUERY);
    await workflows.start(DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId(projectId), [{ projectId, mode }], 'bo');
    await ending(temporal.env.client.workflow.getHandle(deleteProjectWorkflowId(projectId)).result());
  })));
  return deletions;
}

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
      StopProjectWorkActivity: async () => { seen.push('stop'); return [work('run-1'), work('build-1', 'executePipelineRunWorkflow')]; },
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
        return passes === 1 ? { open: [work('late-run')], apps: 0, workspaces: 1, secrets: 0 } : { open: [], apps: 0, workspaces: 0, secrets: 0 };
      },
      ...deletedForGood(seen),
      ArchiveProjectActivity: async () => { seen.push('archived'); return { keptUntil: '2027-02-19T10:00:00.000Z' }; },
    };
    const taskQueue = uniqueName('delete-project-test');
    const worker = await testWorker(temporal.env, { taskQueue, workflows: 'DeleteProjectWorkflow.ts', activities });
    const clusterWorker = await testWorker(temporal.env, {
      taskQueue: QUEUES.cluster,
      activities: {
        AwaitProjectWorkActivity: async ({ workflowId }: { workflowId: string }) => { seen.push(`await ${workflowId}`); return { frozen: workflowId === 'run-1' ? ['worker-engine-7d9f'] : [] }; },
        RestartWorkerActivity: async ({ worker: identity }: { worker: string }) => { seen.push(`restart ${identity}`); return 'restarted' as const; },
      },
    });
    const { worker: streamWorker, told, deletions } = await groveTold(temporal.env);

    await appsWorker.runUntil(clusterWorker.runUntil(streamWorker.runUntil(worker.runUntil(async () => {
      const workflows = temporalRemovalWorkflows<{ projectId: string; mode: 'archive' | 'permanent' }, ProjectRemovalStep>(() => temporal.env.client, taskQueue, PROJECT_REMOVAL_PROGRESS_QUERY);
      await workflows.start(DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId('p1'), [{ projectId: 'p1', mode: 'permanent' }], 'bo');
      expect(await temporal.env.client.workflow.getHandle(deleteProjectWorkflowId('p1')).result()).toMatchObject({
        stopped: ['run-1', 'build-1', 'late-run'], restarted: ['worker-engine-7d9f'], sweeps: 2, repositories: ['koala-bo/shop'], files: 2, records: { projects: 1 },
      });
    }))));
    expect(seen.filter((step) => !step.startsWith('await ') && !step.startsWith('restart '))).toEqual([
      'stop', 'apps', 'destroy shop in shop-1a2b3c', 'workspaces', 'secrets',
      'sweep 1', 'sweep 2',
      'repositories', 'files', 'records',
    ]);
    expect(seen.indexOf('restart worker-engine-7d9f'), 'a frozen worker is restarted once its work closed').toBeGreaterThan(seen.indexOf('await run-1'));
    expect(seen.indexOf('apps'), 'nothing is deleted before the work it found has closed').toBeGreaterThan(Math.max(seen.indexOf('await run-1'), seen.indexOf('await build-1'), seen.indexOf('restart worker-engine-7d9f')));
    expect(seen.indexOf('sweep 2'), 'a pass that found work waits for it to close').toBeGreaterThan(seen.indexOf('await late-run'));
    expect(told).toEqual(['bo']);
    expect(new Set(deletions.map((change) => `${change.ownerId} ${change.projectId}`))).toEqual(new Set(['bo p1']));
    const states = (id: string) => [...deletions].sort((a, b) => a.progress.seq - b.progress.seq).map((change) => change.progress.work.find((item) => item.workflowId === id)?.state).filter((state, at, all) => state && state !== all[at - 1]);
    expect(states('run-1'), 'the person sees the worker restarting, then restarted').toEqual(['stopping', 'restarting', 'restarted']);
    expect(states('build-1')).toEqual(['stopping', 'stopped']);
    const last = latest(deletions);
    expect(last).toMatchObject({ phase: 'deleted', parts: { apps: { state: 'deleted', left: 0, deleted: 1 }, workspaces: { deleted: 2 }, secrets: { deleted: 1 }, repositories: { deleted: 1 }, files: { deleted: 2 }, records: { deleted: 1 } } });
    expect(last?.work.map((item) => [item.workflowId, item.state])).toEqual([['run-1', 'restarted'], ['build-1', 'stopped'], ['late-run', 'stopped']]);
    expect(deletions.filter((change) => change.progress.phase === 'deleted').length, 'Deleted is told once, at the end').toBe(1);
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
      SweepProjectActivity: async () => { seen.push('sweep'); return { open: [], apps: 0, workspaces: 0, secrets: 0 }; },
      ...deletedForGood(seen),
      ArchiveProjectActivity: async () => { seen.push('archived'); return { keptUntil: '2027-02-19T10:00:00.000Z' }; },
    };
    const deletions = await deleting(activities, 'p2', 'archive', async (ended) => {
      expect(await ended).toMatchObject({ archived: true, repositories: [], files: 0, records: {} });
    });
    expect(seen).toEqual(['stop', 'apps', 'workspaces', 'secrets', 'sweep', 'archived']);
    expect(latest(deletions)).toMatchObject({ phase: 'archived', keptUntil: '2027-02-19T10:00:00.000Z' });
  });

  it('tells the person why a part can never be deleted, and never says it is deleted', async () => {
    const seen: string[] = [];
    const activities: ProjectDeletionActivities = {
      StopProjectWorkActivity: async () => [],
      RemoveProjectAppsActivity: async () => [],
      RemoveProjectAppStartedActivity: async () => undefined,
      RemoveProjectWorkspacesActivity: async () => 0,
      RemoveProjectSecretsActivity: async () => ({ workspace: false, readers: 0 }),
      SweepProjectActivity: async () => ({ open: [], apps: 0, workspaces: 0, secrets: 0 }),
      ...deletedForGood(seen),
      RemoveProjectRepositoriesActivity: async () => { throw ApplicationFailure.nonRetryable('Gitea refused to delete koala-bo/shop: 403'); },
      ArchiveProjectActivity: async () => ({ keptUntil: '2027-02-19T10:00:00.000Z' }),
    };
    const deletions = await deleting(activities, 'p3', 'permanent', async (ended) => {
      await expect(ended).rejects.toThrow();
    });
    expect(latest(deletions)).toMatchObject({ phase: 'deleting', problem: 'Gitea refused to delete koala-bo/shop: 403', parts: { repositories: { state: 'deleting' } } });
    expect(deletions.some((change) => change.progress.phase === 'deleted')).toBe(false);
    expect(seen).toEqual([]);
  });

  it('shows a service it needs as down, since when and why, and carries on when the service is back', async () => {
    const seen: string[] = [];
    let secretsAsked = 0;
    const since = '2026-11-21T10:05:00.000Z';
    const activities: ProjectDeletionActivities = tellingWhenDown({
      StopProjectWorkActivity: async () => [],
      RemoveProjectAppsActivity: async () => [],
      RemoveProjectAppStartedActivity: async () => undefined,
      RemoveProjectWorkspacesActivity: async () => 0,
      RemoveProjectSecretsActivity: async () => {
        secretsAsked += 1;
        if (secretsAsked === 1) throw new DependencyDownError('infisical', since, 'it cannot be reached: ECONNREFUSED');
        return { workspace: true, readers: 0 };
      },
      SweepProjectActivity: async () => ({ open: [], apps: 0, workspaces: 0, secrets: 0 }),
      ...deletedForGood(seen),
      ArchiveProjectActivity: async () => ({ keptUntil: '2027-02-19T10:00:00.000Z' }),
    }, deletionToldThrough(async () => temporal.env.client));
    const deletions = await deleting(activities, 'p4', 'permanent', async (ended) => {
      expect(await ended).toMatchObject({ archived: false });
    });
    const ordered = [...deletions].sort((a, b) => a.progress.seq - b.progress.seq).map((change) => change.progress);
    const shownDown = ordered.findIndex((progress) => progress.down?.length);
    expect(ordered[shownDown]?.down, 'the person sees which service is down, since when and why').toEqual([{ step: 'RemoveProjectSecretsActivity', dependency: 'infisical', name: 'Infisical', since, reason: 'it cannot be reached: ECONNREFUSED' }]);
    expect(ordered.slice(0, shownDown).some((progress) => progress.phase === 'deleted')).toBe(false);
    expect(latest(deletions)).toMatchObject({ phase: 'deleted', down: [], parts: { secrets: { state: 'deleted', deleted: 1 } } });
  });
});
