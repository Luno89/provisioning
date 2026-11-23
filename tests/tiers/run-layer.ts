import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { WORKSPACES } from '../coupling/workspaces.js';
import { judgeLayer, KNOWN_SLOW, readSlow, SLOW_LIST, SLOW_LIST_FROM } from '../lib/slow.js';
import { LAYER_BUDGET, type Layer } from '../lib/timings.js';
import { filesListed, noFilesIn, workspacesWithFiles } from './layers.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const VITEST = join(ROOT, 'node_modules', '.bin', 'vitest');

const layer = process.argv[2] as Layer;
if (!(layer in LAYER_BUDGET)) {
  console.error(`run-layer takes one of ${Object.keys(LAYER_BUDGET).join(', ')}, not ${layer}`);
  process.exit(1);
}

const listed = new Map(WORKSPACES.map((workspace) => {
  const listing = spawnSync(VITEST, ['list', '--filesOnly', '--project', layer], { cwd: join(ROOT, workspace.folder), encoding: 'utf8' });
  if (listing.status !== 0) {
    console.error(`${workspace.name}: listing the ${layer} files failed\n${listing.stdout}${listing.stderr}`);
    process.exit(1);
  }
  return [workspace.name, filesListed(layer, listing.stdout)];
}));

const ones = workspacesWithFiles(WORKSPACES, listed);
if (ones.length === 0) {
  console.error(noFilesIn(layer));
  process.exit(1);
}

let seconds = 0;
for (const workspace of ones) {
  const started = Date.now();
  const ran = spawnSync(VITEST, ['run', '--project', layer], { cwd: join(ROOT, workspace.folder), stdio: 'inherit' });
  seconds += (Date.now() - started) / 1000;
  if (ran.status !== 0) {
    console.error(`${workspace.name}: the ${layer} layer failed`);
    process.exit(ran.status ?? 1);
  }
}

const judged = judgeLayer(layer, seconds, readSlow(process.env[SLOW_LIST_FROM] ?? SLOW_LIST));
if (judged.known) console.log(`${judged.known}: ${KNOWN_SLOW}`);
if (judged.stale) console.log(`${judged.stale} is on the slow list and the layer is within its budget, prune it: npx tsx tests/tiers/slow.ts --prune "${judged.stale}"`);
if (judged.failing) {
  console.error(judged.failing);
  process.exit(1);
}
