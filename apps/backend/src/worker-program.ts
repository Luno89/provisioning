import dotenv from 'dotenv';
import { ignore } from '@koala/engine-core/failures';
import type { Telemetry } from '@koala/engine-core/telemetry-sdk';
import { Runtime, type Logger, type Worker } from '@temporalio/worker';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { SettingsError } from './platform/index.js';
import { serveHealth } from './infrastructure/index.js';
import { runThenLetGo } from './platform/wiring/fences.js';

interface ProgramSettings {
  listenHost: string;
  temporalMetricsPort: number;
  healthPort: number;
}

export interface WorkerProgram<S extends ProgramSettings> {
  tag: string;
  logger: Logger;
  settingsFrom: (env: NodeJS.ProcessEnv) => S;
  start: (settings: S) => Promise<{ worker: Worker; telemetry: Telemetry; fences: Parameters<typeof runThenLetGo>[1] }>;
  listening: (settings: S) => string;
}

async function runWorker<S extends ProgramSettings>(program: WorkerProgram<S>): Promise<void> {
  dotenv.config({ quiet: true });
  const settings = program.settingsFrom(process.env);
  Runtime.install({
    logger: program.logger,
    telemetryOptions: {
      metrics: {
        prometheus: {
          bindAddress: `${settings.listenHost}:${settings.temporalMetricsPort}`,
        },
      },
    },
  });
  const { worker, telemetry, fences } = await program.start(settings);
  program.logger.info(`${program.tag} ✅ ${program.listening(settings)}`);
  if (settings.healthPort) serveHealth(settings.healthPort, settings.listenHost, () => worker.getState() === 'RUNNING');
  await runThenLetGo(worker, fences);
  await telemetry.shutdown().catch(ignore('the worker has stopped, and telemetry the collector did not take is dropped as it is whenever the collector is away'));
}

export function runAsProgram<S extends ProgramSettings>(moduleUrl: string, program: WorkerProgram<S>): void {
  const startedAsProgram = process.argv[1] !== undefined && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;
  if (startedAsProgram) runWorker(program).then(() => {
    process.exit(0);
  }, (err: Error) => {
    program.logger.error(err instanceof SettingsError ? `${program.tag} ${err.message}` : `${program.tag} FATAL: ${err.stack || err.message}`);
    process.exit(1);
  });
}
