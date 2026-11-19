import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { generateKey, keyId, leaseMongo, loadKey, missingKeyLines, reencrypt, sealedBeforeKeys, type Keyring } from '../platform/index.js';
import { generateIdentityKey } from '../instances/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(here, '../../.env');
const DATA_DIR = resolve(here, '../../data');
const KEY_FILES = ['.gitea-admin-token', '.headscale-api-key'];

const argv = process.argv.slice(2);
const args = new Set(argv);
const apply = args.has('--apply');
const databases = argv.flatMap((arg, index) => (arg === '--database' && argv[index + 1] ? [argv[index + 1]!] : []));

function writeMissingKeys(): void {
  const present = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const jwtSecret = /^JWT_SECRET=(.+)$/m.exec(present)?.[1];
  const { lines, written } = missingKeyLines(present, { key: generateKey, identity: generateIdentityKey }, jwtSecret);
  if (lines.length === 0) {
    console.log(`keys: all of them are already in ${ENV_FILE}`);
    return;
  }
  appendFileSync(ENV_FILE, `${present.endsWith('\n') || present === '' ? '' : '\n'}${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(`keys: wrote ${written.join(', ')} to ${ENV_FILE}`);
  if (jwtSecret) console.log('keys: what was sealed under JWT_SECRET moves onto DATA_KEY with --apply; JWT_SECRET is read only by this program now');
}

export interface Resealed {
  counts: Array<{ at: string; values: number }>;
  unreadable: string[];
}

export async function resealDatabases(mongoUri: string, databases: readonly string[], ring: Keyring, apply: boolean): Promise<Resealed> {
  const lease = await leaseMongo(mongoUri);
  const resealed: Resealed = { counts: [], unreadable: [] };
  try {
    for (const database of databases) {
      const db = lease.client.db(database);
      for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
        const collection = db.collection(name);
        let count = 0;
        for await (const doc of collection.find({})) {
          const result = reencrypt(doc, ring);
          resealed.unreadable.push(...result.unreadable.map((path) => `${database}.${name}/${String(doc._id)}: ${path}`));
          if (result.rewritten.length === 0) continue;
          count += result.rewritten.length;
          if (apply) await collection.replaceOne({ _id: doc._id }, result.value);
        }
        if (count > 0) resealed.counts.push({ at: `${database}.${name}`, values: count });
      }
    }
  } finally {
    await lease.release();
  }
  return resealed;
}

async function main(): Promise<void> {
  if (args.has('--write-env')) {
    writeMissingKeys();
    return;
  }
  dotenv.config({ path: ENV_FILE, override: true, quiet: true });
  const mongoUri = process.env.MONGO_URI?.trim();
  if (!mongoUri) throw new Error('MONGO_URI is not set: it names the Mongo server whose databases are re-sealed');
  if (databases.length === 0) throw new Error('name every database to re-seal with --database <name> (one each); nothing is re-sealed by default, so a database another Koala or an older one keeps is never touched');
  const ring = sealedBeforeKeys(loadKey(process.env, 'data'), process.env.JWT_SECRET, 'data');
  console.log(`${apply ? 'rewriting' : 'dry run — pass --apply to rewrite'} ${databases.join(', ')}: onto DATA_KEY ${keyId(ring.current)}, from ${ring.previous?.length ? 'JWT_SECRET and the key derived from it' : 'nothing else, since JWT_SECRET is not set'}`);

  const resealed = await resealDatabases(mongoUri, databases, ring, apply);
  for (const { at, values } of resealed.counts) console.log(`  ${at}: ${values} value(s)`);
  let total = resealed.counts.reduce((sum, { values }) => sum + values, 0);
  const unreadable = [...resealed.unreadable];

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
    console.log('Every stored secret is on DATA_KEY. Remove JWT_SECRET from .env once no Temporal workflow started before now is still running: no Koala process reads it, so a payload sealed under it can no longer be opened.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
