#!/usr/bin/env node
/* eslint-disable no-console */
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createDatabase } from './lib/db-interface.js';
import { createModelService } from './lib/model-wiring.js';
import { createWorkerLogger } from './lib/worker-logger.js';
import { buildDataConverter } from './lib/temporal-codec.js';

import { createEventBus } from './engine/events.js';
import { createRunEnvironments } from './engine/adapters/run-environments.js';
import { createSandboxDriver } from './engine/drivers/sandbox.js';
import { createClusterBackend } from './engine/adapters/cluster-backend.js';
import { createKubeRunner } from './engine/adapters/kube.js';
import { createImageBuilder } from './engine/adapters/image-builder.js';
import { BUILDER_TOOLS } from './engine/builder-tools-catalogue.js';
import { createAgentRegistry } from './engine/adapters/registry.js';
import { createEndpointResolver } from './engine/adapters/endpoints.js';
import { createEnvironmentResolver } from './engine/adapters/environments.js';
import { createMachineBackend } from './engine/adapters/machine-backend.js';
import { createToolRuntime } from './engine/adapters/tool-runtime.js';
import { createPlatformTools } from './engine/adapters/platform-tools.js';
import { createTaskTools } from './engine/adapters/task-tools.js';
import { buildWebTools } from './lib/web-tools-wiring.js';
import { createEngineActivities } from './engine/temporal/activities.js';
import { DEFAULT_ENGINE_TASK_QUEUE } from './engine/temporal/contracts.js';

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
  const registry = createAgentRegistry();
  const endpoints = createEndpointResolver({ models, registry });

  const kube = createKubeRunner({ kubeconfig: process.env.KUBECONFIG_PATH });

  const runEnvironments = createRunEnvironments({
    provision: async ({ id, ticket, spec, workspace, scope }) => {
      if (!workspace) {
        throw new Error(`Run ${ticket.runId} asked for a sandbox without a resolved workspace spec.`);
      }

      void id;
      return createSandboxDriver({
        sandboxId: workspace.runId,
        spec,
        ...(scope ? { scope } : {}),
        backend: createClusterBackend({ run: kube, workspace }),
      });
    },
    onLeak: (runId, ageMs) => {
      logger.warn(`[engine] sandbox for ${runId} outlived its run by ${Math.round(ageMs / 60_000)}m — tearing it down`);
    },
  });

  const sweeper = setInterval(() => {
    void runEnvironments.sweep();
  }, 10 * 60_000);
  sweeper.unref();

  const environments = createEnvironmentResolver({
    registry,
    environments: runEnvironments,
    images: createImageBuilder({ run: kube, ...(process.env.KOALA_REGISTRY ? { registry: process.env.KOALA_REGISTRY } : {}) }),
    tools: async () => BUILDER_TOOLS,
    machineBackend: createMachineBackend(),
  });

  const bus = createEventBus();
  bus.subscribe((event) => {
    if (event.type === 'thinking' || event.type === 'content') return;
    logger.info(`[engine] ${event.runId} ${event.type}`);
  });

  const web = await buildWebTools(db).catch(() => undefined);

  const tools = createToolRuntime({
    registry,
    environments,
    handlers: {
      ...createTaskTools({
        store: {
          list: (ownerId: string) => db.getTasks(ownerId),
          save: (task) => db.saveTask(task),
        },
      }),
      ...createPlatformTools({
        ...(web
          ? {
            web: {
              search: async (query: string) => {
                const outcome = await web.search(query);
                return outcome.unavailable
                  ? { error: 'Search is unavailable — no backend could be reached. Rephrasing will not help.' }
                  : { results: outcome.hits };
              },
              fetchPage: (url: string) => web.fetchPage(url),
            },
          }
          : {}),
        memory: {
          remember: async (item) => {
            await db.saveMemory(item);
            return { action: 'saved' };
          },
        },
      }),
    },
  });

  return createEngineActivities({
    registry,
    endpoints,
    environments,
    tools,
    merges: {
      run: async ({ children }) => ({
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
