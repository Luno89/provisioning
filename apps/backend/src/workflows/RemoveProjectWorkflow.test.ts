import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PROJECT_REMOVAL_PROGRESS_QUERY, REMOVE_PROJECT_WORKFLOW, removeProjectWorkflowId, type ProjectRemovalStep } from '../lib/project-removal.js';
import { temporalRemovalWorkflows } from '../services/AccountRemovalService.js';
import type { ProjectRemovalActivities } from '../activities/RemoveProjectActivities.js';
import { temporalTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe('deleting a project through Temporal', () => {
  it('stops its runs, destroys its app on the cluster worker, then deletes its workspaces, secrets, repositories, files and records, saying how far it has got', async () => {
    const seen: string[] = [];
    const clusterQueue = `remove-project-apps-${Math.random().toString(36).slice(2, 8)}`;
    const clusterWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: clusterQueue,
      workflowsPath: resolve(__dirname, 'DestroyAppWorkflow.ts'),
      activities: { DestroyAppActivity: async (args: { name: string; namespace?: string }) => { seen.push(`destroy ${args.name} in ${args.namespace}`); return { status: 'destroyed', msg: '' }; } },
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    const activities: ProjectRemovalActivities = {
      RemoveProjectWorkflowsActivity: async () => { seen.push('workflows'); return 0; },
      RemoveProjectAppsActivity: async () => {
        seen.push('apps');
        return [{ deploymentId: 'd1', workflowId: `app-destroy-shop-${clusterQueue}`, taskQueue: clusterQueue, args: { name: 'shop', clusterId: 'c', clusterName: 'system', provider: 'k3d', strategy: 'helm', logFile: '/tmp/x.log', appType: 'odoo-project', namespace: 'shop-1a2b3c' } }];
      },
      RemoveProjectWorkspacesActivity: async () => { seen.push('workspaces'); return 2; },
      RemoveProjectSecretsActivity: async () => { seen.push('secrets'); await held; return { workspace: true, readers: 1 }; },
      RemoveProjectRepositoriesActivity: async () => { seen.push('repositories'); return ['koala-bo/shop']; },
      RemoveProjectFilesActivity: async () => { seen.push('files'); return 'removed'; },
      RemoveProjectRecordsActivity: async () => { seen.push('records'); return { projects: 1 }; },
    };
    const taskQueue = `remove-project-test-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: resolve(__dirname, 'RemoveProjectWorkflow.ts'), activities });

    const told: string[] = [];
    const streamWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: DEFAULT_STREAM_TASK_QUEUE,
      activities: { EngineGroveChangedActivity: async ({ ownerId }: { ownerId: string }) => { told.push(ownerId); } },
    });

    await streamWorker.runUntil(clusterWorker.runUntil(worker.runUntil(async () => {
      const workflows = temporalRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>(() => env.client, taskQueue, PROJECT_REMOVAL_PROGRESS_QUERY);
      await workflows.start(REMOVE_PROJECT_WORKFLOW, removeProjectWorkflowId('p1'), [{ projectId: 'p1' }], 'bo');
      for (let tries = 0; tries < 100; tries += 1) {
        const state = await workflows.state(removeProjectWorkflowId('p1'));
        if (state.state === 'running' && state.done.length === 3) break;
        await new Promise((settle) => setTimeout(settle, 100));
      }
      expect(await workflows.state(removeProjectWorkflowId('p1'))).toEqual({ state: 'running', done: ['workflows', 'apps', 'workspaces'] });
      release();
      expect(await env.client.workflow.getHandle(removeProjectWorkflowId('p1')).result()).toEqual({
        stoppedWorkflows: 0, apps: 1, workspaces: 2, secrets: { workspace: true, readers: 1 }, repositories: ['koala-bo/shop'], files: 'removed', records: { projects: 1 },
      });
    })));
    expect(seen).toEqual(['workflows', 'apps', 'destroy shop in shop-1a2b3c', 'workspaces', 'secrets', 'repositories', 'files', 'records']);
    expect(told, 'the owner\'s browsers are told the grove changed').toEqual(['bo']);
  }, 60_000);
});
