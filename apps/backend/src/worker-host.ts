#!/usr/bin/env node
import { dirname } from 'path';
import { fileURLToPath } from 'url';

import { RootRemovalInstanceActivity, RootRemovalMeshActivity, RootRemovalRecordsActivity } from './activities/RootRemovalActivities.js';
import { DependencyWatchActivity } from './activities/DependencyWatchActivity.js';
import { KoalaInstallAskActivity, KoalaInstallStageActivity, KoalaInstallStoppedActivity } from './activities/KoalaInstallActivities.js';
import { ServerOrderBootstrapActivity, ServerOrderDnsActivity, ServerOrderFailedActivity, ServerOrderFollowActivity, ServerOrderMailCheckActivity, ServerOrderRebuildActivity, ServerOrderReleaseActivity, ServerOrderReverseDnsActivity, ServerOrderSshActivity, ServerOrderStoppedActivity } from './activities/RootNodeActivities.js';
import { CrawlBatchActivity, NextBatchActivity, SeedFrontierActivity, DiscardFrontierActivity, PurgeCorpusActivity, NewIngestIdActivity } from './activities/CrawlActivity.js';
import { createDatabase, createWorkerLogger, connectTemporalAs, deletingMarksIn, refuseWorkWith, hostWorkerSettingsFrom, keepPayloadsIn, temporalTlsProblem, telemetrySettings } from './platform/index.js';
import { giveHostActivities, hostClusterAccess } from './activities/host-settings.js';
import { sharedClusterProxy } from './infrastructure/index.js';
import { collectorSink } from './monitoring/index.js';
import { checkServices } from './platform/wiring/dependencies.js';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { backendWorkerOnceTemporalAnswers } from './worker-interceptors.js';
import { HOST_ACTIVITIES, QUEUES, type HostWorkerSettings } from './platform/index.js';
import { holdFencesIn } from './platform/wiring/fences.js';
import { runAsProgram, watchedWorker } from './worker-program.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const logger = createWorkerLogger('host-worker');

export const HOST_WORKER_ACTIVITIES = {
  DependencyWatchActivity,
  ServerOrderFollowActivity, ServerOrderRebuildActivity, ServerOrderSshActivity, ServerOrderDnsActivity, ServerOrderReleaseActivity,
  ServerOrderBootstrapActivity, ServerOrderReverseDnsActivity, ServerOrderMailCheckActivity, ServerOrderStoppedActivity, ServerOrderFailedActivity,
  RootRemovalInstanceActivity, RootRemovalMeshActivity, RootRemovalRecordsActivity,
  KoalaInstallAskActivity, KoalaInstallStageActivity, KoalaInstallStoppedActivity,
  CrawlBatchActivity, NextBatchActivity, SeedFrontierActivity, DiscardFrontierActivity, PurgeCorpusActivity, NewIngestIdActivity,
};

export function hostActivitiesFor(role: HostWorkerSettings['role']['role']): Partial<typeof HOST_WORKER_ACTIVITIES> {
  const names = HOST_ACTIVITIES[role];
  return Object.fromEntries(Object.entries(HOST_WORKER_ACTIVITIES).filter(([name]) => names.includes(name)));
}

export async function startHostWorker(settings: HostWorkerSettings) {
  logger.keepIn(settings.dataDir);
  const telemetry = startTelemetry(telemetrySettings(settings, 'koala-worker-host'));
  const access = hostClusterAccess(settings);
  const telemetryProxy = sharedClusterProxy(access);
  telemetry.exportTo(collectorSink({ otlpEndpoint: settings.telemetry.otlpEndpoint, proxy: telemetryProxy, koalasCluster: () => access.own().clusterId }));
  const dependencies = await watchedWorker(settings, telemetry, { proxy: telemetryProxy, koalasCluster: () => access.own().clusterId });
  checkServices(dependencies, { webTools: settings.webTools });
  const plaintext = temporalTlsProblem(settings.temporal);
  if (plaintext) throw new Error(plaintext);
  connectTemporalAs(settings);
  keepPayloadsIn(settings.mongo);
  const db = createDatabase({ mongo: settings.mongo, dataKey: settings.keys.data });
  db.reportReachTo(dependencies);
  await db.init();
  refuseWorkWith(deletingMarksIn(db));
  const fences = await holdFencesIn('worker-host', settings.mongo);
  giveHostActivities(settings, access, dependencies);
  void dependencies.start();
  const queue = QUEUES.host;
  const { address } = settings.temporal;
  logger.info(`[HostWorker] Starting — taskQueue=${queue}, address=${address}`);

  const worker = await backendWorkerOnceTemporalAnswers(settings, { tag: '[HostWorker]', logger, dependencies }, {
    subject: 'koala-worker-host',
    taskQueue: queue,
    activities: hostActivitiesFor(settings.role.role),
  });

  return { worker, telemetry, fences };
}

runAsProgram(import.meta.url, {
  tag: '[HostWorker]',
  logger,
  settingsFrom: hostWorkerSettingsFrom,
  start: startHostWorker,
  listening: (settings) => `Listening for ${settings.role.role}'s work on the host queue`,
});
