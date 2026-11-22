import { resolve } from 'node:path';
import type { Client } from '@temporalio/client';
import type { Worker } from '@temporalio/worker';
import { afterAll, beforeAll } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import type { TestTemporal } from '@koala/engine-core/testing/temporal';
import { createFrozenWorkActivities, createProjectDeletionActivities, deletionToldThrough, temporalProjectArchive, temporalProjectWork, type ProjectWork } from '../../activities/DeleteProjectActivities.js';
import { createProjectRemovalActivities, type ProjectRemovalDeps } from '../../activities/RemoveProjectActivities.js';
import type { KubeRunner } from '../../engine-host/sandboxes/kube.js';
import { DEFAULT_STREAM_TASK_QUEUE } from '../../engine-host/temporal/contracts.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { QUEUES } from '../../platform/lib/work-places.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { bundled, realTemporalEnvironment } from './temporal-test-env.js';
import { testWorker } from './test-worker.js';
import type { ToldDeletion } from './removal-steps.js';

export const fakeApps = { clusterById: async () => undefined, handOver: async (clusterId: string) => ({ clusterId, reach: { clusterId, kind: 'koala' as const } }), logFile: () => '/tmp/destroy.log', taskQueue: QUEUES.cluster };

export const quietKube = (): KubeRunner => mockFn<KubeRunner>().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

export interface RemovalWorld {
  readonly env: TestTemporal;
  readonly db: MongoDB;
}

export function removalWorld(): RemovalWorld {
  let env: TestTemporal | undefined;
  let db: MongoDB | undefined;
  beforeAll(async () => {
    env = await realTemporalEnvironment();
    db = await testDatabase();
  });
  afterAll(async () => { await env?.teardown(); });
  const made = <T>(thing: T | undefined): T => {
    if (!thing) throw new Error('this file\'s Temporal and database are made in beforeAll; a test reached them before');
    return thing;
  };
  return { get env() { return made(env); }, get db() { return made(db); } };
}

export interface RemovalWorkers {
  work: ProjectWork;
  workers: Worker[];
}

export async function removalWorkers(world: RemovalWorld, client: Client, queue: string, options: {
  workflows: string;
  activities?: (work: ProjectWork) => object;
  step: (args: { ownerId: string; projectId: string }) => Promise<string>;
  told: ToldDeletion[];
}): Promise<RemovalWorkers> {
  const { env, db } = world;
  const work = temporalProjectWork(async () => client);
  const removal = createProjectRemovalActivities({
    ...mock<ProjectRemovalDeps>(),
    store: db,
    apps: fakeApps,
    kube: quietKube(),
    repositories: { deleteRepo: async () => undefined },
    secrets: { removeProject: async () => ({ workspace: false, readers: 0 }) },
    webhooks: { unhook: async () => 0 },
    files: { removeProjectFiles: async () => 0 },
  });
  const deletion = createProjectDeletionActivities({ work, removal, archive: temporalProjectArchive(async () => client, db.projects, queue), told: deletionToldThrough(async () => client) });
  const workers = await Promise.all([
    testWorker(env, { taskQueue: queue, workflowBundle: await bundled(resolve(import.meta.dirname, '..', options.workflows)), activities: { ...deletion, ...options.activities?.(work) } }),
    testWorker(env, { taskQueue: QUEUES.cluster, activities: createFrozenWorkActivities({ work, workers: { restart: async () => 'not-here' }, machines: () => db.machines.getLocalAgentDevices() }) }),
    testWorker(env, { taskQueue: `${queue}-step`, workflowBundle: await bundled(resolve(import.meta.dirname, 'project-step.fixture-workflow.ts'), [resolve(import.meta.dirname, '..', 'telemetry-interceptors.ts')]), activities: { ProjectStepActivity: options.step } }),
    testWorker(env, { taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities: { EngineGroveChangedActivity: async () => undefined, ProjectDeletionChangedActivity: async (change: ToldDeletion) => { options.told.push(change); } } }),
  ]);
  return { work, workers };
}
