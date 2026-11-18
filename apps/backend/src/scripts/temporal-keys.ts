import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadKey, temporalJwksText, writeTemporalJwks } from '../platform/index.js';

dotenv.config({ path: resolve(fileURLToPath(new URL('.', import.meta.url)), '../../.env'), quiet: true });
const key = loadKey(process.env, 'temporal');
const target = process.argv[2];
if (target) {
  await writeTemporalJwks(target, key);
  console.log(`[temporal-keys] Temporal reads Koala's public key from ${target}`);
} else {
  process.stdout.write(temporalJwksText(key));
}
