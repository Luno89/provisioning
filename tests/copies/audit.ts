import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { against, counted, exempt, keyOf, MARKER, markedRegions, markedWithout, movedIn, pruned, where, type Baseline, type Region } from './rules.js';
import { scan } from './scan.js';

const args = process.argv.slice(2);
const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const root = resolve(value('--root') ?? join(import.meta.dirname, '..', '..'));
const seed = args.includes('--seed-baseline');
const prune = args.includes('--prune');
const BASELINE = join(root, 'tests', 'copies', 'baseline.json');

const regionsByFile = new Map<string, Region[]>();
const regions = (file: string): Region[] => {
  let found = regionsByFile.get(file);
  if (!found) {
    const text = readFileSync(join(root, file), 'utf8');
    found = text.includes(MARKER) ? markedRegions(text, file) : [];
    regionsByFile.set(file, found);
  }
  return found;
};

const write = (baseline: Baseline) => {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 1)}\n`);
};

const started = Date.now();
const all = await scan(root);
const found = all.filter((copy) => !exempt(copy, regions));
const seconds = Math.round((Date.now() - started) / 100) / 10;
const byScope = (scope: string) => found.filter((copy) => copy.scope === scope).length;
console.log(`copies ${seconds}s: ${byScope('src')} in src, ${byScope('tests')} in tests, ${all.length - found.length} marked and named`);

if (!existsSync(BASELINE)) {
  if (!seed) {
    console.log(`${BASELINE} does not exist: run once with --seed-baseline to record today's copies`);
    process.exitCode = 1;
  } else {
    write(counted(found));
    console.log(`baseline written: ${found.length} copies`);
  }
} else if (seed) {
  console.log(`${BASELINE} exists: the baseline only shrinks, so it is never seeded again; use --prune`);
  process.exitCode = 1;
} else {
  const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
  const moved = movedIn(before, found);
  for (const move of moved.moves) console.log(`moved: ${move.from} -> ${move.to} (${move.count})`);
  const baseline = prune ? pruned(moved.baseline, found) : moved.baseline;
  const held = against(found, baseline);
  for (const copy of held.added) {
    console.log(`new copy in ${copy.scope}: ${where(copy)} (${keyOf(copy)})`);
    for (const line of markedWithout(copy, regions)) console.log(`  ${line}`);
  }
  for (const entry of held.fixed) console.log(`fixed, prune it: ${entry.key} (${entry.was} -> ${entry.now})`);
  if (prune && held.added.length === 0) write(baseline);
  if (held.added.length > 0 || held.fixed.length > 0) process.exitCode = 1;
}
