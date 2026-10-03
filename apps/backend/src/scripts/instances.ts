import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createDatabase } from '../lib/db-interface.js';
import { roleFromEnv } from '../lib/platform-role.js';
import { IdentityService } from '../services/IdentityService.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

const USAGE = 'usage: npm run instances -w apps/backend -- list | add <id> <owner-user-id> <url> | remove <id>';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const db = createDatabase();
  await db.init();
  const identity = new IdentityService(roleFromEnv(process.env), db);

  if (command === 'list') {
    const all = await db.getInstances();
    if (all.length === 0) console.log('no instances registered');
    for (const instance of all) console.log(`${instance.id}\t${instance.ownerId}\t${instance.url}`);
  } else if (command === 'add' && rest.length === 3) {
    const [id, ownerId, url] = rest as [string, string, string];
    if (!await db.getUserById(ownerId)) throw new Error(`there is no user ${ownerId} on this root`);
    const result = await identity.register({ id, ownerId, url });
    if (!result.ok) throw new Error(result.error);
    console.log(`registered ${result.instance.id} for ${ownerId} at ${result.instance.url}`);
  } else if (command === 'remove' && rest.length === 1) {
    await db.deleteInstance(rest[0]!);
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
