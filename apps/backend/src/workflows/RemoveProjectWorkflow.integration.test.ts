import { activityInterceptors } from '@koala/engine-core';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PROJECT_REMOVAL_PROGRESS_QUERY, REMOVE_PROJECT_WORKFLOW, removeProjectWorkflowId, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import { temporalRemovalWorkflows } from '../accounts/services/AccountRemovalService.js';
import { mock } from 'vitest-mock-extended';
import { createProjectRemovalActivities, type ProjectRemovalActivities, type ProjectRemovalDeps } from '../activities/RemoveProjectActivities.js';
import type { DeploymentMetadata } from '../platform/lib/types.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { bundled, temporalTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe('deleting a project through Temporal', () => {
  it('fences the project, stops its runs and deletes its repositories, destroys its app on the cluster worker, then deletes its workspaces, secrets, files and records, saying how far it has got', async () => {
    const seen: string[] = [];
    const clusterQueue = `remove-project-apps-${Math.random().toString(36).slice(2, 8)}`;
    const clusterWorker = await Worker.create({
      interceptors: { activity: activityInterceptors() },
      ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
      taskQueue: clusterQueue,
      workflowBundle: await bundled(resolve(__dirname, 'DestroyAppWorkflow.ts')),
      activities: { DestroyAppActivity: async (args: { name: string; namespace?: string }) => { seen.push(`destroy ${args.name} in ${args.namespace}`); return { status: 'destroyed', msg: '' }; } },
    });
    const db = await testDatabase();
    await db.infrastructure.saveDeployment({ id: 'd1', name: 'shop', clusterId: 'c', strategy: 'helm', status: 'destroying', ownerId: 'bo', temporalWorkflowId: '' } as DeploymentMetadata);
    const real = createProjectRemovalActivities({ ...mock<ProjectRemovalDeps>(), store: db });
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    let reached: () => void = () => undefined;
    const atSecrets = new Promise<void>((done) => { reached = done; });
    const activities: ProjectRemovalActivities = {
      RemoveProjectFenceActivity: async () => { seen.push('fence'); return []; },
      RemoveProjectWorkflowsActivity: async () => { seen.push('workflows'); return 0; },
      RemoveProjectAppsActivity: async () => {
        seen.push('apps');
        return [{ deploymentId: 'd1', workflowId: `app-destroy-shop-${clusterQueue}`, taskQueue: clusterQueue, args: { name: 'shop', clusterId: 'c', clusterName: 'system', provider: 'k3d', strategy: 'helm', logFile: '/tmp/x.log', appType: 'odoo-project', namespace: 'shop-1a2b3c', reach: { clusterId: 'c', kind: 'koala' as const } } }];
      },
      RemoveProjectAppStartedActivity: real.RemoveProjectAppStartedActivity,
      RemoveProjectWorkspacesActivity: async () => { seen.push('workspaces'); return 2; },
      RemoveProjectSecretsActivity: async () => { seen.push('secrets'); reached(); await held; return { workspace: true, readers: 1 }; },
      RemoveProjectRepositoriesActivity: async () => { seen.push('repositories'); return ['koala-bo/shop']; },
      RemoveProjectFilesActivity: async () => { seen.push('files'); return 2; },
      RemoveProjectRecordsActivity: async () => { seen.push('records'); return { projects: 1 }; },
    };
    const taskQueue = `remove-project-test-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue, workflowBundle: await bundled(resolve(__dirname, 'RemoveProjectWorkflow.ts')), activities });

    const told: string[] = [];
    const streamWorker = await Worker.create({
      interceptors: { activity: activityInterceptors() },
      ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
      taskQueue: DEFAULT_STREAM_TASK_QUEUE,
      activities: { EngineGroveChangedActivity: async ({ ownerId }: { ownerId: string }) => { told.push(ownerId); } },
    });

    await streamWorker.runUntil(clusterWorker.runUntil(worker.runUntil(async () => {
      const workflows = temporalRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>(() => env.client, taskQueue, PROJECT_REMOVAL_PROGRESS_QUERY);
      await workflows.start(REMOVE_PROJECT_WORKFLOW, removeProjectWorkflowId('p1'), [{ projectId: 'p1' }], 'bo');
      await atSecrets;
      expect(await workflows.state(removeProjectWorkflowId('p1'))).toEqual({ state: 'running', done: ['workflows', 'repositories', 'apps', 'workspaces'] });
      release();
      expect(await env.client.workflow.getHandle(removeProjectWorkflowId('p1')).result()).toEqual({
        stoppedWorkflows: 0, apps: 1, workspaces: 2, secrets: { workspace: true, readers: 1 }, repositories: ['koala-bo/shop'], files: 2, records: { projects: 1 },
      });
    })));
    expect(seen).toEqual(['fence', 'workflows', 'repositories', 'apps', 'destroy shop in shop-1a2b3c', 'workspaces', 'secrets', 'files', 'records']);
    expect((await db.infrastructure.getDeployments()).find((dep) => dep.id === 'd1')?.temporalWorkflowId, 'the app names its destroy once that destroy has started').toBe(`app-destroy-shop-${clusterQueue}`);
    expect(told, 'the owner\'s browsers are told the grove changed').toEqual(['bo']);
  }, 60_000);
});
