import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { localCommands, runSteps, StepFailed, terminalReporter } from '@koala/provision';
import { loadKey, rootServicesAsked, rootServiceSteps, rootServicesIn } from '../platform/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../../..');
const TEMPORAL_RUNS_AS = { uid: 1000, gid: 1000 };

dotenv.config({ path: resolve(here, '../../.env'), quiet: true });
const { program, names } = rootServicesAsked(process.argv.slice(2));
const services = {
  ...rootServicesIn(REPO, program, () => loadKey(process.env, 'temporal')),
  ...(process.getuid?.() === 0 ? { tlsOwner: TEMPORAL_RUNS_AS } : {}),
};

try {
  await runSteps(rootServiceSteps(services, names), { commands: localCommands(process.env) }, terminalReporter(process.stdout));
} catch (err) {
  if (!(err instanceof StepFailed)) throw err;
  process.exitCode = 1;
}
