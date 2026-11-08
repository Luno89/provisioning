#!/usr/bin/env node
import dotenv from 'dotenv';
import { ignore } from '@koala/engine-core/failures';
import { Worker, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { DeployAppActivity, type DeployAppArgs } from './activities/DeployAppActivity.js';
import { CheckWorkloadActivity, type CheckWorkloadArgs } from './activities/CheckWorkloadActivity.js';
import { DestroyAppActivity, type DestroyAppArgs } from './activities/DestroyAppActivity.js';
import { ResizeDiskActivity, type ResizeDiskArgs } from './activities/ResizeDiskActivity.js';
import { SyncConfigActivity, type SyncConfigArgs } from './activities/SyncConfigActivity.js';
import { DownloadModelActivity } from './activities/DownloadModelActivity.js';
import { VerifyGpuRuntimeActivity, type VerifyGpuRuntimeArgs } from './activities/VerifyGpuRuntimeActivity.js';
import { RunPipelineActivity, type RunPipelineArgs } from './activities/RunPipelineActivity.js';
import type { ClusterSteps } from './activities/cluster-steps.js';
import { createWorkerLogger, buildDataConverter, connectTemporalWorker, temporalTlsProblem, sharedPayloadBlobs, loadKeys, roleFromEnv, telemetrySettings, temporalNamespaceFrom } from './platform/index.js';
import { clusterAccessFrom, healthPort, serveHealth, InfisicalService, infisicalSettingsFrom, InfrastructureService, sharedClusterProxy } from './infrastructure/index.js';
import { GiteaService, giteaSettingsFrom } from './projects/index.js';
import { heartbeatWhileRunning, WORKER_DEFAULTS } from '@koala/engine-core';
import { traceActivities } from '@koala/engine-core/telemetry';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { ensureClusterMonitoring } from './activities/cluster-monitoring.js';
import { collectorSink, koalaClusterMonitoring } from './monitoring/index.js';
import { workflowInterceptorModules } from './worker-interceptors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ quiet: true });

const telemetry = startTelemetry(telemetrySettings(process.env, 'koala-worker-cluster'));
const role = roleFromEnv(process.env).role;
const access = clusterAccessFrom(process.env, { role });
telemetry.exportTo(collectorSink({ env: process.env, proxy: sharedClusterProxy(access), koalasCluster: () => access.own().clusterId }));
const logger = createWorkerLogger('cluster-worker');

Runtime.install({
  logger,
  telemetryOptions: {
    metrics: {
      prometheus: {
        bindAddress: `0.0.0.0:${process.env.TEMPORAL_METRICS_PORT || '9464'}`,
      },
    },
  },
});

async function main() {
  const plaintext = temporalTlsProblem(process.env);
  if (plaintext) throw new Error(plaintext);
  const dataKey = loadKeys(process.env).data;
  const steps: ClusterSteps = { access, infra: new InfrastructureService(), gitea: new GiteaService(dataKey, giteaSettingsFrom(process.env)), infisical: new InfisicalService(dataKey, infisicalSettingsFrom(process.env)) };

  const queue = process.env.TEMPORAL_TASK_QUEUE || 'cluster-ops-queue';
  const address = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
  logger.info(`[ClusterWorker] Starting — taskQueue=${queue}, address=${address}`);

  let worker;
  while (true) {
    try {
      const connection = await connectTemporalWorker(address, 'koala-worker-cluster', process.env);
      const dataConverter = buildDataConverter(loadKeys(process.env).payload, sharedPayloadBlobs());
      worker = await Worker.create({
    ...WORKER_DEFAULTS,
        connection,
        namespace: temporalNamespaceFrom(process.env),
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        interceptors: { activity: [heartbeatWhileRunning(), traceActivities()], workflowModules: workflowInterceptorModules(process.env) },
        activities: {
          DeployAppActivity: (args: DeployAppArgs) => DeployAppActivity(args, steps),
          CheckWorkloadActivity: (args: CheckWorkloadArgs) => CheckWorkloadActivity(args, steps),
          DestroyAppActivity: (args: DestroyAppArgs) => DestroyAppActivity(args, steps),
          ResizeDiskActivity: (args: ResizeDiskArgs) => ResizeDiskActivity(args, steps),
          SyncConfigActivity: (args: SyncConfigArgs) => SyncConfigActivity(args, steps),
          DownloadModelActivity,
          VerifyGpuRuntimeActivity: (args: VerifyGpuRuntimeArgs) => VerifyGpuRuntimeActivity(args, steps),
          RunPipelineActivity: (args: RunPipelineArgs) => RunPipelineActivity(args, steps),
        },
      });
      break;
    } catch (err) {
      logger.warn(`[ClusterWorker] ⚠️ Connection to Temporal server failed: ${(err as Error).message}. Retrying in 10s...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  logger.info('[ClusterWorker] ✅ Listening for app deployment tasks');
  ensureClusterMonitoring(steps, koalaClusterMonitoring(process.env, steps.access.own(), role === 'instance'))
    .then(() => logger.info('[ClusterWorker] the system cluster has monitoring and Koala\'s own telemetry stack'))
    .catch((err: Error) => logger.warn(`[ClusterWorker] monitoring could not be installed yet; the next deploy tries again: ${err.message}`));
  const port = healthPort(process.env);
  if (port) serveHealth(port, () => worker.getState() === 'RUNNING');
  await worker.run();
}

main().then(async () => {
  await telemetry.shutdown().catch(ignore('the worker has stopped, and telemetry the collector did not take is dropped as it is whenever the collector is away'));
  process.exit(0);
}, (err: Error) => {
  logger.error(`[ClusterWorker] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
