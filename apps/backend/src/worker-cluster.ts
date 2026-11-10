#!/usr/bin/env node
import dotenv from 'dotenv';
import { ignore } from '@koala/engine-core/failures';
import { Worker, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { DeployAppActivity, type DeployAppArgs } from './activities/DeployAppActivity.js';
import { CheckWorkloadActivity, type CheckWorkloadArgs } from './activities/CheckWorkloadActivity.js';
import { DestroyAppActivity, type DestroyAppArgs } from './activities/DestroyAppActivity.js';
import { ResizeDiskActivity, type ResizeDiskArgs } from './activities/ResizeDiskActivity.js';
import { SyncConfigActivity, type SyncConfigArgs } from './activities/SyncConfigActivity.js';
import { DownloadModelActivity } from './activities/DownloadModelActivity.js';
import { VerifyGpuRuntimeActivity, type VerifyGpuRuntimeArgs } from './activities/VerifyGpuRuntimeActivity.js';
import { RunPipelineActivity, type RunPipelineArgs } from './activities/RunPipelineActivity.js';
import type { ClusterSteps } from './activities/cluster-steps.js';
import { type ClusterWorkerSettings, createWorkerLogger, buildDataConverter, clusterWorkerSettingsFrom, connectTemporalWorker, connectTemporalAs, keepPayloadsIn, reopening, temporalTlsProblem, sharedPayloadBlobs, SettingsError, telemetrySettings } from './platform/index.js';
import { clusterAccessFrom, serveHealth, InfisicalService, InfrastructureService, sharedClusterProxy, terraformPlacesFor } from './infrastructure/index.js';
import { GiteaService } from './projects/index.js';
import { activityInterceptors, WORKER_DEFAULTS } from '@koala/engine-core';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { Context } from '@temporalio/activity';
import { ensureClusterMonitoring } from './activities/cluster-monitoring.js';
import { collectorEndpoint, collectorSink, koalaClusterMonitoring } from './monitoring/index.js';
import { checkServices, collectorAnswers, reportCollectorTo, workerDependencies } from './platform/wiring/dependencies.js';
import { workflowInterceptorModules } from './worker-interceptors.js';
import { QUEUES } from './platform/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const logger = createWorkerLogger('cluster-worker');

export async function startClusterWorker(settings: ClusterWorkerSettings) {
  const telemetry = startTelemetry(telemetrySettings(settings, 'koala-worker-cluster'));
  const access = clusterAccessFrom(settings.clusters, { role: settings.role.role });
  const telemetryProxy = sharedClusterProxy(access);
  telemetry.exportTo(collectorSink({ otlpEndpoint: settings.telemetry.otlpEndpoint, proxy: telemetryProxy, koalasCluster: () => access.own().clusterId }));
  const dependencies = workerDependencies(settings, settings.mongo);
  reportCollectorTo(telemetry, dependencies);
  dependencies.checkWith('collector', collectorAnswers(settings.telemetry.otlpEndpoint ? () => settings.telemetry.otlpEndpoint : collectorEndpoint({ proxy: telemetryProxy, koalasCluster: () => access.own().clusterId })));
  const plaintext = temporalTlsProblem(settings.temporal);
  if (plaintext) throw new Error(plaintext);
  connectTemporalAs(settings);
  keepPayloadsIn(settings.mongo);
  const dataKey = settings.keys.data;
  const steps: ClusterSteps = {
    access,
    infra: new InfrastructureService(terraformPlacesFor(settings.terraform)),
    gitea: new GiteaService(dataKey, settings.gitea, { registryPullHost: settings.registryPullHost, reportsTo: dependencies }),
    infisical: new InfisicalService(dataKey, settings.infisical, dependencies),
    database: { mongo: settings.mongo, dataKey },
    machineMetricsUrl: settings.machineMetricsUrl,
  };

  checkServices(dependencies, { gitea: settings.gitea.url, infisical: settings.infisical.url });
  void dependencies.start();
  const queue = QUEUES.cluster;
  const { address } = settings.temporal;
  logger.info(`[ClusterWorker] Starting — taskQueue=${queue}, address=${address}`);

  let worker;
  const connecting = reopening();
  while (true) {
    try {
      const connection = await connectTemporalWorker('koala-worker-cluster', settings);
      const dataConverter = buildDataConverter(settings.keys.payload, sharedPayloadBlobs());
      worker = await Worker.create({
    ...WORKER_DEFAULTS,
        connection,
        namespace: settings.temporal.namespace,
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        interceptors: { activity: activityInterceptors(), workflowModules: workflowInterceptorModules(settings.role) },
        activities: {
          DeployAppActivity: (args: DeployAppArgs) => DeployAppActivity(args, steps, Context.current().cancellationSignal),
          CheckWorkloadActivity: (args: CheckWorkloadArgs) => CheckWorkloadActivity(args, steps),
          DestroyAppActivity: (args: DestroyAppArgs) => DestroyAppActivity(args, steps),
          ResizeDiskActivity: (args: ResizeDiskArgs) => ResizeDiskActivity(args, steps, Context.current().cancellationSignal),
          SyncConfigActivity: (args: SyncConfigArgs) => SyncConfigActivity(args, steps, Context.current().cancellationSignal),
          DownloadModelActivity,
          VerifyGpuRuntimeActivity: (args: VerifyGpuRuntimeArgs) => VerifyGpuRuntimeActivity(args, steps),
          RunPipelineActivity: (args: RunPipelineArgs) => RunPipelineActivity(args, steps),
        },
      });
      break;
    } catch (err) {
      dependencies.failed('temporal', err);
      logger.warn(`[ClusterWorker] ⚠️ Connection to Temporal server failed: ${(err as Error).message}. Retrying in ${connecting.seconds} s`);
      await connecting.after();
    }
  }

  return { worker: worker!, steps, telemetry };
}

async function main() {
  dotenv.config({ quiet: true });
  const settings = clusterWorkerSettingsFrom(process.env);
  Runtime.install({
    logger,
    telemetryOptions: {
      metrics: {
        prometheus: {
          bindAddress: `0.0.0.0:${settings.temporalMetricsPort}`,
        },
      },
    },
  });
  const { worker, steps, telemetry } = await startClusterWorker(settings);
  logger.info('[ClusterWorker] ✅ Listening for app deployment tasks');
  ensureClusterMonitoring(steps, koalaClusterMonitoring(Boolean(settings.clusters.here.poolName), steps.access.own()))
    .then(() => logger.info('[ClusterWorker] the cluster this Koala runs in has monitoring and Koala\'s own telemetry stack'))
    .catch((err: Error) => logger.warn(`[ClusterWorker] monitoring could not be installed yet; the next deploy tries again: ${err.message}`));
  if (settings.healthPort) serveHealth(settings.healthPort, () => worker.getState() === 'RUNNING');
  await worker.run();
  await telemetry.shutdown().catch(ignore('the worker has stopped, and telemetry the collector did not take is dropped as it is whenever the collector is away'));
}

const startedAsProgram = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (startedAsProgram) main().then(() => {
  process.exit(0);
}, (err: Error) => {
  logger.error(err instanceof SettingsError ? `[ClusterWorker] ${err.message}` : `[ClusterWorker] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
