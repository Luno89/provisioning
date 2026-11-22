#!/usr/bin/env node
import { dirname } from 'path';
import { fileURLToPath } from 'url';

import { DeployAppActivity, type DeployAppArgs } from './activities/DeployAppActivity.js';
import { CheckWorkloadActivity, type CheckWorkloadArgs } from './activities/CheckWorkloadActivity.js';
import { DestroyAppActivity, type DestroyAppArgs } from './activities/DestroyAppActivity.js';
import { ResizeDiskActivity, type ResizeDiskArgs } from './activities/ResizeDiskActivity.js';
import { SyncConfigActivity, type SyncConfigArgs } from './activities/SyncConfigActivity.js';
import { DownloadModelActivity, type DownloadModelArgs } from './activities/DownloadModelActivity.js';
import { VerifyGpuRuntimeActivity, type VerifyGpuRuntimeArgs } from './activities/VerifyGpuRuntimeActivity.js';
import { RunPipelineActivity, type RunPipelineArgs } from './activities/RunPipelineActivity.js';
import type { ClusterSteps } from './activities/cluster-steps.js';
import { ProvisionPieceActivity, recordedLines, type ProvisionLines, type ProvisionPieceRun, type ProvisionPlace } from './activities/ProvisionPieceActivity.js';
import { type ClusterWorkerSettings, createDatabase, refuseWorkWith, deletingMarksIn, createWorkerLogger, clusterWorkerSettingsFrom, connectTemporalAs, keepPayloadsIn, temporalTlsProblem, telemetrySettings } from './platform/index.js';
import { clusterAccessFrom, InfisicalService, InfrastructureService, ProvisionAsks, sharedClusterProxy, terraformPlacesFor, type Provisioner } from './infrastructure/index.js';
import { GiteaService, ProjectRepoService } from './projects/index.js';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { Context } from '@temporalio/activity';
import { collectorSink } from './monitoring/index.js';
import { checkServices } from './platform/wiring/dependencies.js';
import { backendWorkerOnceTemporalAnswers } from './worker-interceptors.js';
import { QUEUES } from './platform/index.js';
import { HUGGING_FACE } from './infrastructure/index.js';
import { runAsProgram, watchedWorker } from './worker-program.js';
import { createFrozenWorkActivities, temporalProjectWork } from './activities/DeleteProjectActivities.js';
import { KoalaPods, WorkerRestart } from './infrastructure/index.js';
import { getTemporalClient } from './platform/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const logger = createWorkerLogger('cluster-worker');

export interface ClusterSetup {
  place: ProvisionPlace;
  lines: ProvisionLines;
  provisioner: Provisioner;
}

export const clusterActivities = (steps: ClusterSteps, setup: ClusterSetup, huggingFace: string = HUGGING_FACE) => ({
      DeployAppActivity: (args: DeployAppArgs) => DeployAppActivity(args, { ...steps, provisioner: setup.provisioner }, Context.current().cancellationSignal),
      CheckWorkloadActivity: (args: CheckWorkloadArgs) => CheckWorkloadActivity(args, steps),
      DestroyAppActivity: (args: DestroyAppArgs) => DestroyAppActivity(args, steps),
      ResizeDiskActivity: (args: ResizeDiskArgs) => ResizeDiskActivity(args, steps, Context.current().cancellationSignal),
      SyncConfigActivity: (args: SyncConfigArgs) => SyncConfigActivity(args, steps, Context.current().cancellationSignal),
      DownloadModelActivity: (args: DownloadModelArgs) => DownloadModelActivity(args, steps, huggingFace),
      VerifyGpuRuntimeActivity: (args: VerifyGpuRuntimeArgs) => VerifyGpuRuntimeActivity(args, steps),
      RunPipelineActivity: (args: RunPipelineArgs) => RunPipelineActivity(args, steps),
      ProvisionPieceActivity: (run: ProvisionPieceRun) => ProvisionPieceActivity(run, { steps, place: setup.place, lines: setup.lines }),
});

export async function startClusterWorker(settings: ClusterWorkerSettings) {
  logger.keepIn(settings.dataDir);
  const telemetry = startTelemetry(telemetrySettings(settings, 'koala-worker-cluster'));
  const access = clusterAccessFrom(settings.clusters, { role: settings.role.role });
  const telemetryProxy = sharedClusterProxy(access);
  telemetry.exportTo(collectorSink({ otlpEndpoint: settings.telemetry.otlpEndpoint, proxy: telemetryProxy, koalasCluster: () => access.own().clusterId }));
  const dependencies = await watchedWorker(settings, telemetry, { proxy: telemetryProxy, koalasCluster: () => access.own().clusterId });
  const plaintext = temporalTlsProblem(settings.temporal);
  if (plaintext) throw new Error(plaintext);
  connectTemporalAs(settings);
  keepPayloadsIn(settings.mongo);
  const dataKey = settings.keys.data;
  const db = createDatabase({ mongo: settings.mongo, dataKey });
  db.reportReachTo(dependencies);
  await db.init();
  refuseWorkWith(deletingMarksIn(db));
  const steps: ClusterSteps = {
    access,
    infra: new InfrastructureService(terraformPlacesFor(settings.terraform, settings.dataDir, settings.clusters.chartSources)),
    gitea: new GiteaService(dataKey, settings.gitea, { dataDir: settings.dataDir, registryPullHost: settings.registryPullHost, reportsTo: dependencies }),
    infisical: new InfisicalService(dataKey, settings.infisical, settings.dataDir, dependencies),
    database: { mongo: settings.mongo, dataKey },
    machineMetricsUrl: settings.machineMetricsUrl,
  };

  checkServices(dependencies, { gitea: settings.gitea.url, infisical: settings.infisical.url });
  void dependencies.start();
  void new ProjectRepoService(db, steps.gitea, dataKey).keepRevokingLeftovers(new KoalaPods({ access, target: () => access.own(), namespace: settings.podNamespace }));
  const queue = QUEUES.cluster;
  const { address } = settings.temporal;
  logger.info(`[ClusterWorker] Starting — taskQueue=${queue}, address=${address}`);

  const worker = await backendWorkerOnceTemporalAnswers(settings, { tag: '[ClusterWorker]', logger, dependencies }, {
    subject: 'koala-worker-cluster',
    taskQueue: queue,
    activities: {
      ...clusterActivities(steps, {
        place: { koalaNamespace: settings.podNamespace, pool: Boolean(settings.clusters.here.poolName), dataDir: settings.dataDir, crawl4aiToken: settings.crawl4aiToken, qdrantApiKey: settings.qdrantApiKey },
        lines: recordedLines(db.infrastructure),
        provisioner: new ProvisionAsks({ store: db.infrastructure, koala: settings.koala }),
      }, settings.tests.huggingFaceUrl),
      ...createFrozenWorkActivities({
        work: temporalProjectWork(() => getTemporalClient()),
        workers: new WorkerRestart({ access, target: () => access.own(), namespace: settings.podNamespace }),
        machines: () => db.machines.getLocalAgentDevices(),
        machineGone: (deviceId, stop) => db.machines.untilDeviceGone(deviceId, stop),
      }),
    },
  });

  return { worker, steps, telemetry };
}

runAsProgram(import.meta.url, {
  tag: '[ClusterWorker]',
  logger,
  settingsFrom: clusterWorkerSettingsFrom,
  start: startClusterWorker,
  listening: () => 'Listening for app deployment tasks',
});
