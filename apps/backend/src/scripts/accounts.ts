import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createDatabase } from '../platform/index.js';
import { emailProblem, normalEmail, readiedForProviderLink } from '../accounts/index.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

const USAGE = 'usage: npm run accounts -w apps/backend -- prepare-provider-link <user-id> <email>';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'prepare-provider-link' || rest.length !== 2) {
    console.error(USAGE);
    process.exit(2);
  }
  const [userId, given] = rest as [string, string];
  const email = normalEmail(given);
  const malformed = emailProblem(email);
  if (malformed) throw new Error(`${given}: ${malformed}`);
  const db = createDatabase();
  await db.init();
  try {
    const user = await db.accounts.getUserById(userId);
    if (!user) throw new Error(`there is no account ${userId} in this database`);
    const readied = readiedForProviderLink(user, email, await db.accounts.getUserByEmail(email));
    if (!readied.ok) throw new Error(readied.why);
    await db.accounts.saveUser(readied.user);
    console.log(`${userId} is now ${email}, confirmed, with no provider linked: the next Google, GitHub or OpenID sign-in that says ${email} is verified joins it`);
  } finally {
    await db.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
