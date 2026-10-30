import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PINS = fileURLToPath(new URL('../dependencies.pins.json', import.meta.url));
const LIST = fileURLToPath(new URL('../apps/backend/assets/breached-passwords.txt.gz', import.meta.url));
export const SOURCES = ['seclists-ncsc-100k', 'seclists-pwdb-top-1000000'];
export const SHORTEST = 12;

export function breachedList(texts) {
  const kept = new Set();
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const password = line.toLowerCase();
      if (password.length >= SHORTEST) kept.add(password);
    }
  }
  return [...kept].sort();
}

export const packed = (passwords) => gzipSync(Buffer.from(`${passwords.join('\n')}\n`), { level: 9 });

async function main() {
  const pins = JSON.parse(readFileSync(PINS, 'utf8'));
  const texts = [];
  for (const name of SOURCES) {
    const source = pins.components.find((component) => component.name === name);
    if (!source) throw new Error(`${name} is not in dependencies.pins.json`);
    const response = await fetch(source.source);
    if (!response.ok) throw new Error(`${source.source} answered ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (sha256 !== source.sha256) throw new Error(`${name} has sha256 ${sha256}, not the pinned ${source.sha256}`);
    texts.push(body.toString('utf8'));
  }
  const list = packed(breachedList(texts));
  if (process.argv.includes('--check')) {
    if (!readFileSync(LIST).equals(list)) throw new Error(`${LIST} is not what the pinned lists make; run node scripts/breached-passwords.mjs`);
    console.log(`${LIST} is what the pinned lists make`);
    return;
  }
  writeFileSync(LIST, list);
  console.log(`wrote ${LIST}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
