import { fileURLToPath } from 'node:url';
import { Hopeless, type ChartCluster, type WaitOptions } from '@koala/provision';
import { clusterAccessFrom } from '../infrastructure/index.js';
import { setupWaits } from '../instances/index.js';
import { mongoClientFor, setupWaitsSettingsFrom, type SetupWaitsSettings } from '../platform/index.js';

const AUTHENTICATION_FAILED = 18;

async function mongoAnswers(uri: string): Promise<void> {
  const client = mongoClientFor(uri);
  try {
    await client.db('admin').command({ ping: 1 });
  } catch (err) {
    if ((err as { code?: unknown }).code === AUTHENTICATION_FAILED) throw new Hopeless(`the instance's Mongo refused its own password: ${(err as Error).message}`);
    throw err;
  } finally {
    await client.close();
  }
}

export async function setupWaitsOn(settings: Pick<SetupWaitsSettings, 'step' | 'after' | 'podNamespace' | 'mongo'>, cluster: Pick<ChartCluster, 'kubectl'>, say: (line: string) => void, wait: WaitOptions = {}): Promise<void> {
  say(`[setup] ${settings.step} waits for the instance's Mongo${settings.after.length ? ` and for ${settings.after.join(', ')}` : ''}`);
  await setupWaits(settings.step, settings.after, {
    job: async (name) => JSON.parse(await cluster.kubectl(['get', 'job', name, '-n', settings.podNamespace, '-o', 'json'])) as unknown,
    mongo: () => mongoAnswers(settings.mongo.uri),
    wait: { waiting: (what, last) => say(`[setup] still waiting for ${what}${last ? ` (${last})` : ''}`), ...wait },
  });
  say(`[setup] ${settings.step} may run`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const settings = setupWaitsSettingsFrom(process.env);
  const access = clusterAccessFrom(settings.clusters, { role: settings.role.role });
  setupWaitsOn(settings, access.chartCluster(access.own()), (line) => console.log(line)).catch((err: Error) => {
    console.error(`[setup] ${err.message}`);
    process.exitCode = 1;
  });
}
