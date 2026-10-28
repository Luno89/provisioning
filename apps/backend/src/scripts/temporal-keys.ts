import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadKeys, temporalJwks } from '../platform/index.js';

dotenv.config({ path: resolve(fileURLToPath(new URL('.', import.meta.url)), '../../.env'), quiet: true });
const jwks = `${JSON.stringify(temporalJwks(loadKeys(process.env, ['temporal']).temporal))}\n`;
const target = process.argv[2];
if (target) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.new`, jwks, { mode: 0o644 });
  renameSync(`${target}.new`, target);
  console.log(`[temporal-keys] Temporal reads Koala's public key from ${target}`);
} else {
  process.stdout.write(jwks);
}
