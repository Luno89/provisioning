import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadKey, temporalJwksText, writeTemporalJwks } from '../platform/index.js';

export async function temporalKeys(target: string | undefined, env: Readonly<Record<string, string | undefined>>, out: { write(text: string): unknown }): Promise<void> {
  const key = loadKey(env, 'temporal');
  if (target) {
    await writeTemporalJwks(target, key);
    out.write(`[temporal-keys] Temporal reads Koala's public key from ${target}\n`);
  } else {
    out.write(temporalJwksText(key));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  dotenv.config({ path: resolve(fileURLToPath(new URL('.', import.meta.url)), '../../.env'), quiet: true });
  await temporalKeys(process.argv[2], process.env, process.stdout);
}
