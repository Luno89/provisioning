import { fileURLToPath } from 'node:url';
import { Hopeless } from '@koala/provision';
import { clusterAccessFrom } from '../infrastructure/index.js';
import { setupWaits } from '../instances/index.js';
import { mongoClientFor, setupWaitsSettingsFrom } from '../platform/index.js';

const AUTHENTICATION_FAILED = 18;

async function main(): Promise<void> {
  const settings = setupWaitsSettingsFrom(process.env);
  const access = clusterAccessFrom(settings.clusters, { role: settings.role.role });
  const own = access.own();
  console.log(`[setup] ${settings.step} waits for the instance's Mongo${settings.after.length ? ` and for ${settings.after.join(', ')}` : ''}`);
  await setupWaits(settings.step, settings.after, {
    job: async (name) => JSON.parse(await access.kubectl(own, ['get', 'job', name, '-n', settings.podNamespace, '-o', 'json'])) as unknown,
    mongo: async () => {
      const client = mongoClientFor(settings.mongo.uri);
      try {
        await client.db('admin').command({ ping: 1 });
      } catch (err) {
        if ((err as { code?: unknown }).code === AUTHENTICATION_FAILED) throw new Hopeless(`the instance's Mongo refused its own password: ${(err as Error).message}`);
        throw err;
      } finally {
        await client.close();
      }
    },
    wait: { waiting: (what, last) => console.log(`[setup] still waiting for ${what}${last ? ` (${last})` : ''}`) },
  });
  console.log(`[setup] ${settings.step} may run`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: Error) => {
    console.error(`[setup] ${err.message}`);
    process.exitCode = 1;
  });
}
