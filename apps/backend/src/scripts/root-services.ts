import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { localCommands, runSteps, StepFailed, terminalReporter, type Terminal } from '@koala/provision';
import { loadKey, rootServicesAsked, rootServicesAt, rootServiceSteps, rootServicesIn, type FilesOwner, type RootServicePlaces } from '../platform/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../../..');
const TEMPORAL_RUNS_AS: FilesOwner = { uid: 1000, gid: 1000 };

export interface RootServicesRun {
  places: RootServicePlaces;
  env: Readonly<Record<string, string | undefined>>;
  terminal: Terminal;
  tlsOwner?: FilesOwner | undefined;
}

export const rootServicesHere = (): RootServicePlaces => rootServicesIn(REPO);

export async function rootServices(argv: readonly string[], run: RootServicesRun): Promise<boolean> {
  const { program, names } = rootServicesAsked(argv);
  const services = rootServicesAt(run.places, program, () => loadKey(run.env, 'temporal'), run.tlsOwner);
  try {
    await runSteps(rootServiceSteps(services, names), { commands: localCommands(run.env) }, terminalReporter(run.terminal));
    return true;
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  dotenv.config({ path: resolve(here, '../../.env'), quiet: true });
  const tlsOwner = process.getuid?.() === 0 ? TEMPORAL_RUNS_AS : undefined;
  process.exitCode = await rootServices(process.argv.slice(2), { places: rootServicesHere(), env: process.env, terminal: process.stdout, tlsOwner }) ? 0 : 1;
}
