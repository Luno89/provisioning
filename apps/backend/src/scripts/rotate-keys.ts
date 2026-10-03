import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { KEY_NAMES, generateKey, loadKeys } from '../lib/keys.js';
import { reencrypt } from '../lib/key-rotation.js';
import { keyId } from '../lib/crypto.js';
import { generateIdentityKey } from '../lib/identity-token.js';

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(here, '../../.env');
const DATA_DIR = resolve(here, '../../data');
const KEY_FILES = ['.gitea-admin-token', '.headscale-api-key'];

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

function writeMissingKeys(): void {
  const present = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const missing: string[] = Object.values(KEY_NAMES).filter((name) => !new RegExp(`^${name}=.{32,}$`, 'm').test(present));
  const lines = missing.map((name) => `${name}=${generateKey()}`);
  if (!/^ROOT_IDENTITY_KEY=.+$/m.test(present) && !/^ROLE=instance$/m.test(present)) {
    lines.push(`ROOT_IDENTITY_KEY=${Buffer.from(generateIdentityKey()).toString('base64')}`);
    missing.push('ROOT_IDENTITY_KEY');
  }
  if (lines.length === 0) {
    console.log(`keys: all of them are already in ${ENV_FILE}`);
    return;
  }
  appendFileSync(ENV_FILE, `${present.endsWith('\n') || present === '' ? '' : '\n'}${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(`keys: wrote ${missing.join(', ')} to ${ENV_FILE}`);
}

async function main(): Promise<void> {
  if (args.has('--write-env')) writeMissingKeys();
  dotenv.config({ path: ENV_FILE, override: true });
  const keys = loadKeys(process.env);
  const ring = keys.data;
  console.log(`${apply ? 'rewriting' : 'dry run — pass --apply to rewrite'}: data key ${keyId(ring.current)}, ${ring.previous?.length ?? 0} previous key(s)`);

  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin');
  await client.connect();
  const db = client.db();
  let total = 0;
  const unreadable: string[] = [];

  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    const collection = db.collection(name);
    let count = 0;
    for await (const doc of collection.find({})) {
      const result = reencrypt(doc, ring);
      unreadable.push(...result.unreadable.map((path) => `${name}/${String(doc._id)}: ${path}`));
      if (result.rewritten.length === 0) continue;
      count += result.rewritten.length;
      if (apply) await collection.replaceOne({ _id: doc._id }, result.value);
    }
    if (count > 0) console.log(`  ${name}: ${count} value(s)`);
    total += count;
  }
  await client.close();

  for (const file of KEY_FILES) {
    const path = resolve(DATA_DIR, file);
    if (!existsSync(path)) continue;
    const result = reencrypt(readFileSync(path, 'utf8').trim(), ring);
    unreadable.push(...result.unreadable.map(() => `data/${file}`));
    if (result.rewritten.length === 0) continue;
    total += 1;
    console.log(`  data/${file}: 1 value`);
    if (apply) writeFileSync(path, result.value, { mode: 0o600 });
  }

  console.log(`${apply ? 'rewrote' : 'would rewrite'} ${total} value(s)`);
  if (unreadable.length > 0) {
    console.log(`${unreadable.length} value(s) look encrypted but no key this platform holds opens them, so they were left as they are:`);
    for (const line of unreadable) console.log(`  ${line}`);
  }
  if (apply && unreadable.length === 0) {
    console.log('Every stored secret is on the current key. Remove JWT_SECRET from .env once no Temporal workflow started before now is still running — its history was encrypted with it.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
