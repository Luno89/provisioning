import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prunedSlow, readSlow, SLOW_LIST } from '../lib/slow.js';

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [flag, ...keys] = process.argv.slice(2);
  if (flag !== '--prune' || keys.length === 0) {
    console.error('usage: tsx tests/tiers/slow.ts --prune <key>...');
    process.exit(1);
  }
  writeFileSync(SLOW_LIST, `${JSON.stringify(prunedSlow(readSlow(SLOW_LIST), keys), null, 1)}\n`);
}
