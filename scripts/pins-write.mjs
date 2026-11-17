import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PINS = `${ROOT}dependencies.pins.json`;

const valuesOf = (component) => [
  ...(component.uses ?? []).map((use) => [use, component.version]),
  ...(component.shaUses ?? []).map((use) => [use, use.arch ? component.sha256s?.[use.arch] : component.sha256 ?? component.sha512]),
  ...(component.sourceUses ?? []).map((use) => [use, component.source]),
];

function rewritten(text, pattern, value, where) {
  const matches = [...text.matchAll(new RegExp(pattern, 'gmd'))];
  if (matches.length === 0) throw new Error(`${where} has nothing matching ${pattern}`);
  let out = '';
  let at = 0;
  for (const match of matches) {
    const [start, end] = match.indices[1];
    out += text.slice(at, start) + value;
    at = end;
  }
  return out + text.slice(at);
}

export function pinsWritten(pins, read) {
  const now = new Map();
  for (const component of pins.components) {
    for (const [use, value] of valuesOf(component)) {
      if (value === undefined) throw new Error(`${component.name}: the pins file holds no value for ${use.file}'s ${use.pattern}`);
      const text = now.get(use.file) ?? read(use.file);
      now.set(use.file, rewritten(text, use.pattern, value, `${component.name}: ${use.file}`));
    }
  }
  return new Map([...now].filter(([file, text]) => text !== read(file)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const read = (file) => readFileSync(`${ROOT}${file}`, 'utf8');
  const changed = pinsWritten(JSON.parse(read('dependencies.pins.json')), read);
  for (const [file, text] of changed) {
    console.log(`${check ? 'differs from the pins file' : 'written'}: ${file}`);
    if (!check) writeFileSync(`${ROOT}${file}`, text);
  }
  if (check && changed.size > 0) process.exit(1);
  if (changed.size === 0) console.log(`every file says what ${PINS.slice(ROOT.length)} says`);
}
