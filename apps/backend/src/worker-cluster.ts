#!/usr/bin/env node
import dotenv from 'dotenv';
import { ignore } from '@koala/engine-core/failures';
import { Worker, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

import { DeployAppActivity } from './activities/DeployAppActivity.js';
import { CheckWorkloadActivity } from './activities/CheckWorkloadActivity.js';
import { DestroyAppActivity } from './activities/DestroyAppActivity.js';
import { ResizeDiskActivity } from './activities/ResizeDiskActivity.js';
import { SyncConfigActivity } from './activities/SyncConfigActivity.js';
import { DownloadModelActivity } from './activities/DownloadModelActivity.js';
import { VerifyGpuRuntimeActivity } from './activities/VerifyGpuRuntimeActivity.js';
import { RunPipelineActivity } from './activities/RunPipelineActivity.js';
import { createWorkerLogger, buildDataConverter, connectTemporalWorker, temporalTlsProblem, sharedPayloadBlobs, loadKeys, roleFromEnv, SYSTEM_KUBECONFIG, telemetrySettings, temporalNamespaceFrom } from './platform/index.js';
import { healthPort, serveHealth, InfrastructureService, sharedClusterProxy } from './infrastructure/index.js';
import { heartbeatWhileRunning, WORKER_DEFAULTS } from '@koala/engine-core';
import { traceActivities } from '@koala/engine-core/telemetry';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { ensureClusterMonitoring } from './activities/cluster-monitoring.js';
import { collectorSink, koalaClusterMonitoring } from './monitoring/index.js';
import { workflowInterceptorModules } from './worker-interceptors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ quiet: true });

const telemetry = startTelemetry(telemetrySettings(process.env, 'koala-worker-cluster'));
telemetry.exportTo(collectorSink({ env: process.env, proxy: sharedClusterProxy(), kubeconfigPath: () => process.env.KUBECONFIG_PATH || SYSTEM_KUBECONFIG }));
const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';

const logger = createWorkerLogger('cluster-worker');

async function setupInClusterAuth() {
  if (process.env.IN_CLUSTER !== 'true') return;
  try {
    const [token, caCert] = await Promise.all([
      fs.readFile(`${SA_PATH}/token`, 'utf-8'),
      fs.readFile(`${SA_PATH}/ca.crt`, 'utf-8'),
    ]);
    process.env.K8S_HOST = process.env.K8S_HOST || 'https://kubernetes.default.svc';
    process.env.K8S_TOKEN = token;
    process.env.K8S_CA_CERT = caCert;
    logger.info('[ClusterWorker] In-cluster auth configured');
  } catch (err) {
    logger.warn(`[ClusterWorker] Failed to read service account: ${(err as Error).message}`);
  }
}

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
  await setupInClusterAuth();

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
          DeployAppActivity,
          CheckWorkloadActivity,
          DestroyAppActivity,
          ResizeDiskActivity,
          SyncConfigActivity,
          DownloadModelActivity,
          VerifyGpuRuntimeActivity,
          RunPipelineActivity,
        },
      });
      break;
    } catch (err) {
      logger.warn(`[ClusterWorker] ⚠️ Connection to Temporal server failed: ${(err as Error).message}. Retrying in 10s...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  logger.info('[ClusterWorker] ✅ Listening for app deployment tasks');
  const instance = roleFromEnv(process.env).role === 'instance';
  const systemKubeconfig = instance ? process.env.KUBECONFIG_PATH : (process.env.KUBECONFIG_PATH || SYSTEM_KUBECONFIG);
  const present = (file: string) => fs.access(file).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return false;
    throw err;
  });
  if (systemKubeconfig && await present(systemKubeconfig)) {
    ensureClusterMonitoring(new InfrastructureService(), koalaClusterMonitoring(process.env, systemKubeconfig, instance))
      .then(() => logger.info('[ClusterWorker] the system cluster has monitoring and Koala\'s own telemetry stack'))
      .catch((err: Error) => logger.warn(`[ClusterWorker] monitoring could not be installed yet; the next deploy tries again: ${err.message}`));
  }
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
