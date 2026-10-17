import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createDatabase } from '../lib/db-interface.js';
import { DEV_SPLIT, devSplitOwner, devSplitPlan, envFileText, readEnvFile, withDatabase } from '../lib/dev-split.js';
import { publicKeyPem } from '../lib/identity-token.js';
import { mongoTarget } from '../lib/mongo-db.js';
import { roleFromEnv } from '../lib/platform-role.js';
import { hashCredential, instanceIdFor } from '../services/InstanceService.js';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../../.env') });
const OUT = resolve(here, '../../data/dev-split');

async function main(): Promise<void> {
  const name = process.env.DEV_INSTANCE_NAME?.trim() || DEV_SPLIT.defaultName;
  const instanceDb = createDatabase();
  await instanceDb.init();
  const owner = devSplitOwner(await instanceDb.getUsers(), process.env.DEV_INSTANCE_OWNER?.trim() || undefined);
  await instanceDb.close?.();

  const before = await readFile(resolve(OUT, 'instance.env'), 'utf8').then(readEnvFile).catch(() => ({} as Record<string, string>));
  const credential = before.INSTANCE_CREDENTIAL || crypto.randomBytes(32).toString('base64url');
  const signing = roleFromEnv({ ...process.env, ROLE: 'root' }).signing!;
  const mongoUri = mongoTarget(process.env).uri;
  const instanceId = instanceIdFor(owner.id);

  const rootDb = createDatabase({ ...process.env, MONGO_URI: withDatabase(mongoUri, DEV_SPLIT.rootDatabase) });
  await rootDb.init();
  const plan = devSplitPlan({
    name, owner, instanceId, credential,
    credentialHash: hashCredential(credential),
    rootPublicKeys: publicKeyPem(signing.publicKey),
    mongoUri,
    now: new Date().toISOString(),
    existing: (await rootDb.getInstances(owner.id)).find((entry) => entry.id === instanceId),
  });
  for (const other of await rootDb.getInstances(owner.id)) if (other.id !== instanceId) await rootDb.deleteInstance(other.id);
  await rootDb.saveUser({ ...(await rootDb.getUserById(owner.id) ?? {}), ...plan.rootUser });
  await rootDb.saveInstance(plan.instance);
  await rootDb.close?.();

  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, 'root.env'), envFileText(plan.rootEnv), { mode: 0o600 });
  await writeFile(resolve(OUT, 'instance.env'), envFileText(plan.instanceEnv), { mode: 0o600 });
  console.log(`root     ${plan.rootUrl}  (database ${DEV_SPLIT.rootDatabase}, holds ${owner.email})`);
  console.log(`instance ${plan.instanceUrl}  (${plan.instance.id}, owned by ${owner.email})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`dev:split setup failed: ${(err as Error).message}`);
  process.exit(1);
});
