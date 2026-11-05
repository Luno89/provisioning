import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { mongoTarget, roleFromEnv } from '../platform/index.js';
import { devRootPlan, envFileText, hashCredential, publicKeyPem, readEnvFile } from '../instances/index.js';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../../.env'), quiet: true });
const OUT = resolve(here, '../../data/dev');

async function main(): Promise<void> {
  const before = await readFile(resolve(OUT, 'root.env'), 'utf8').then(readEnvFile).catch(() => ({} as Record<string, string>));
  const hubBefore = await readFile(resolve(OUT, 'hub.env'), 'utf8').then(readEnvFile).catch(() => ({} as Record<string, string>));
  const hubCredential = hubBefore.HUB_CREDENTIAL || crypto.randomBytes(32).toString('base64url');
  const plan = devRootPlan({
    mongoUri: mongoTarget(process.env).uri,
    setupCode: before.ADMIN_SETUP_CODE || crypto.randomBytes(12).toString('base64url'),
    hubCredential,
    hubCredentialHash: hashCredential(hubCredential),
    rootPublicKeys: publicKeyPem(roleFromEnv({ ...process.env, ROLE: 'root' }).signing!.publicKey),
  });
  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, 'root.env'), envFileText(plan.rootEnv), { mode: 0o600 });
  await writeFile(resolve(OUT, 'hub.env'), envFileText(plan.hubEnv), { mode: 0o600 });
  await writeFile(resolve(OUT, 'urls.env'), envFileText({ ROOT_WEB: plan.rootUrl, HUB_WEB: plan.hubUrl, INSTANCE_WEB: plan.instanceUrl }), { mode: 0o600 });
  process.exit(0);
}

main().catch((err) => {
  console.error(`dev: root's settings could not be written: ${(err as Error).message}`);
  process.exit(1);
});
