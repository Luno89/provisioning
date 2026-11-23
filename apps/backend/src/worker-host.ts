#!/usr/bin/env node
import { dirname } from 'path';
import { fileURLToPath } from 'url';

import { RootRemovalInstanceActivity, RootRemovalMachinesActivity, RootRemovalMeshActivity, RootRemovalRecordsActivity } from './activities/RootRemovalActivities.js';
import { DependencyWatchActivity } from './activities/DependencyWatchActivity.js';
import { KoalaInstallAskActivity, KoalaInstallStageActivity, KoalaInstallStoppedActivity } from './activities/KoalaInstallActivities.js';
import { ServerOrderBootstrapActivity, ServerOrderDnsActivity, ServerOrderFailedActivity, ServerOrderFollowActivity, ServerOrderMailCheckActivity, ServerOrderRebuildActivity, ServerOrderReleaseActivity, ServerOrderReverseDnsActivity, ServerOrderSshActivity, ServerOrderStoppedActivity } from './activities/RootNodeActivities.js';
import { createWorkerLogger, hostWorkerSettingsFrom, telemetrySettings } from './platform/index.js';
import { giveHostActivities, hostClusterAccess } from './activities/host-settings.js';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { backendWorkerOnceTemporalAnswers } from './worker-interceptors.js';
import { HOST_ACTIVITIES, QUEUES, type HostWorkerSettings } from './platform/index.js';
import { connectedWorker, runAsProgram } from './worker-program.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const logger = createWorkerLogger('host-worker');

export const HOST_WORKER_ACTIVITIES = {
  DependencyWatchActivity,
  ServerOrderFollowActivity, ServerOrderRebuildActivity, ServerOrderSshActivity, ServerOrderDnsActivity, ServerOrderReleaseActivity,
  ServerOrderBootstrapActivity, ServerOrderReverseDnsActivity, ServerOrderMailCheckActivity, ServerOrderStoppedActivity, ServerOrderFailedActivity,
  RootRemovalInstanceActivity, RootRemovalMachinesActivity, RootRemovalMeshActivity, RootRemovalRecordsActivity,
  KoalaInstallAskActivity, KoalaInstallStageActivity, KoalaInstallStoppedActivity,
};

export function hostActivitiesFor(role: HostWorkerSettings['role']['role']): Partial<typeof HOST_WORKER_ACTIVITIES> {
  const names = HOST_ACTIVITIES[role];
  return Object.fromEntries(Object.entries(HOST_WORKER_ACTIVITIES).filter(([name]) => names.includes(name)));
}

export async function startHostWorker(settings: HostWorkerSettings) {
  logger.keepIn(settings.dataDir);
  const telemetry = startTelemetry(telemetrySettings(settings, 'koala-worker-host'));
  const access = hostClusterAccess(settings);
  const { dependencies } = await connectedWorker(settings, telemetry, access);
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

  return { worker, telemetry };
}

runAsProgram(import.meta.url, {
  tag: '[HostWorker]',
  logger,
  settingsFrom: hostWorkerSettingsFrom,
  start: startHostWorker,
  listening: (settings) => `Listening for ${settings.role.role}'s work on the host queue`,
});
