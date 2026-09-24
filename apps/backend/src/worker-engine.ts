#!/usr/bin/env node
/* eslint-disable no-console */
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createDatabase } from './lib/db-interface.js';
import { createPlanAdoption } from './engine-host/plan-adoption.js';
import { GiteaService } from './services/GiteaService.js';
import { InfrastructureService } from './services/InfrastructureService.js';
import { createModelService } from './lib/model-wiring.js';
import { createWorkerLogger } from './lib/worker-logger.js';
import { buildDataConverter } from './lib/temporal-codec.js';

import { createEventBus } from '@koala/agent-engine';
import {
  createEngineActivities,
  createEffortTracker,
  createEngineHost,
  storesFromDatabase,
  DEFAULT_ENGINE_TASK_QUEUE,
  type Task,
  type MergeArgs,
  type RecordTracesArgs,
} from './engine-host/index.js';
import { createHostNodes, hostNodesFor } from './engine-host/nodes/index.js';
import { buildWebTools } from './lib/web-tools-wiring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, '../.env') });

const logger = createWorkerLogger('engine-worker');

Runtime.install({
  logger,
  telemetryOptions: {
    metrics: {
      prometheus: {
        bindAddress: `0.0.0.0:${process.env.TEMPORAL_ENGINE_METRICS_PORT || '9467'}`,
      },
    },
  },
});

async function buildActivities() {
  const db = createDatabase();
  await db.init();

  const models = createModelService(db, process.env.JWT_SECRET ?? '');
  const web = await buildWebTools(db).catch(() => undefined);

  const gitea = new GiteaService(new InfrastructureService(), process.env.JWT_SECRET || 'provisioning-platform-secret-12345', '/tmp/kubeconfig-provisioning-lunorica');
  const host = createEngineHost({
    models,
    stores: storesFromDatabase(db),
    ...(web ? { web } : {}),
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
    registryAccount: async () => ({ owner: gitea.adminUsername, ...(await gitea.getAdminCredentials()) }),
    registryPushToken: async () => ({ username: gitea.adminUsername, password: (await gitea.createDeployToken()).token }),
    onLeak: (runId, ageMs) => {
      logger.warn(`[engine] sandbox for ${runId} outlived its run by ${Math.round(ageMs / 60_000)}m — tearing it down`);
    },
  });
  const { registry, endpoints, environments, tools } = host;

  const sweeper = setInterval(() => {
    void host.runEnvironments.sweep();
  }, 10 * 60_000);
  sweeper.unref();

  const bus = createEventBus();
  bus.subscribe((event) => {
    if (event.type === 'thinking' || event.type === 'content') return;
    logger.info(`[engine] ${event.runId} ${event.type}`);
  });

  const hostNodes = hostNodesFor(createHostNodes(host.services), ['activity', 'sandbox']);

  return createEngineActivities({
    registry,
    endpoints,
    environments,
    tools,
    hostNodes,
    tasks: {
      list: (ownerId: string) => db.getTasks(ownerId),
      save: (task: Task) => db.saveTask(task),
    },
    treeWorkspaces: host.treeWorkspaces,
    planAdoption: createPlanAdoption({
      stores: {
        proposals: { get: (ownerId, id) => db.getPlanProposal(ownerId, id), save: (proposal) => db.savePlanProposal(proposal) },
        trees: { list: () => db.getTrees(), save: (tree) => db.saveTree(tree) },
        branches: { save: (branch) => db.saveBranch(branch) },
        leaves: { save: (leaf) => db.saveLeaf(leaf) },
        tasks: { save: (task) => db.saveTask(task) },
      },
      treeWorkspaces: host.treeWorkspaces,
      environments: host.environments,
    }),
    grove: {
      trees: { list: () => db.getTrees() },
      branches: { list: () => db.getBranches() },
      leaves: { list: () => db.getLeaves() },
      tasks: { list: () => db.getTasks() },
    },
    effort: createEffortTracker({
      models,
      registry,
      store: {
        save: (effort) => db.saveRunEffort(effort),
        list: (ownerId, procedureId, modelKey) => db.getRunEffort(ownerId, procedureId, modelKey),
      },
    }),
    traces: {
      record: ({ ownerId, runId, agentSlug, procedureId, procedureVersion, traces }: RecordTracesArgs) =>
        db.saveRunTraces(traces.map((trace) => ({ ...trace, ownerId, runId, agentSlug, procedureId, procedureVersion }))),
    },
    merges: {
      run: async ({ children }: MergeArgs) => ({
        children: children.map((child) => ({ agent: child.agentId, outcome: child.outcome, outputs: child.outputs })),
      }),
    },
    bus,
  });
}

async function main() {
  const queue = process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;
  const address = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
  logger.info(`[EngineWorker] Starting — taskQueue=${queue}, address=${address}`);

  const activities = await buildActivities();

  for (;;) {
    try {
      const connection = await NativeConnection.connect({ address });
      const dataConverter = buildDataConverter(process.env.JWT_SECRET);

      const worker = await Worker.create({
        connection,
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        activities,
      });

      logger.info('[EngineWorker] Connected, polling for work');
      await worker.run();
      return;
    } catch (err) {
      logger.error(`[EngineWorker] ${(err as Error).message} — retrying in 5s`);
      await new Promise((done) => setTimeout(done, 5_000));
    }
  }
}

main().catch((err) => {
  logger.error(`[EngineWorker] fatal: ${(err as Error).message}`);
  process.exit(1);
});
