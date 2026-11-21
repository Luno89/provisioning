import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV, devRootPlan, envFileText, readEnvFile } from '../instances/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../data/dev');

async function main(): Promise<void> {
  const before = await readFile(resolve(OUT, 'root.env'), 'utf8').then(readEnvFile).catch(() => ({} as Record<string, string>));
  const plan = devRootPlan({
    mongoUri: DEV.mongo,
    setupCode: before.ADMIN_SETUP_CODE || crypto.randomBytes(12).toString('base64url'),
    temporalCa: resolve(here, '../../data/temporal-tls/ca.crt'),
    dataDir: resolve(here, '../../data'),
  });
  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, 'root.env'), envFileText(plan.rootEnv), { mode: 0o600 });
  await writeFile(resolve(OUT, 'urls.env'), envFileText({ ROOT_WEB: plan.rootUrl, INSTANCE_WEB: plan.instanceUrl }), { mode: 0o600 });
  process.exit(0);
}

main().catch((err) => {
  console.error(`dev: root's settings could not be written: ${(err as Error).message}`);
  process.exit(1);
});
