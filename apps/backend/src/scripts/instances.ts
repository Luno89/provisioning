import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createDatabase, databaseSettingsFrom } from '../platform/index.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

const USAGE = 'usage: npm run instances -w apps/backend -- list | remove <id> (a Koala is added only by putting it on one of its owner\'s machines)';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const db = createDatabase(databaseSettingsFrom(process.env));
  await db.init();

  if (command === 'list') {
    const all = await db.instances.getInstances();
    if (all.length === 0) console.log('no instances registered');
    for (const instance of all) console.log(`${instance.id}\t${instance.ownerId}\t${instance.url}`);
  } else if (command === 'remove' && rest.length === 1) {
    await db.instances.deleteInstance(rest[0]!);
    console.log(`removed ${rest[0]}`);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
