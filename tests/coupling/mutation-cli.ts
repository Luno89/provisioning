import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './artifacts.js';
import { evidenceOf, recordOf, type KeptRun, type MutationReport } from './mutation.js';
import { layerOf } from './v2.js';

export const EVIDENCE = join(ROOT, 'tests', 'coupling', 'evidence.json');

const AREAS: Record<string, { workspace: string; report: string }> = {
  provision: { workspace: 'packages/provision', report: 'tests/.coupling/mutation/provision.json' },
  'infrastructure-lib': { workspace: 'apps/backend', report: 'tests/.coupling/mutation/infrastructure-lib.json' },
};

const [area] = process.argv.slice(2);
const where = area ? AREAS[area] : undefined;
if (!where) throw new Error(`name an area to mutate: ${Object.keys(AREAS).join(', ')}`);
const at = join(ROOT, where.report);
if (!existsSync(at)) throw new Error(`${where.report} does not exist: run stryker in ${where.workspace} first`);
const report = JSON.parse(readFileSync(at, 'utf8')) as MutationReport;
const evidence = evidenceOf(report, layerOf);
const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const kept = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) as KeptRun[] : [];
const run = recordOf(evidence, area!, commit, new Date().toISOString());
writeFileSync(EVIDENCE, `${JSON.stringify([...kept, run], null, 1)}\n`);
console.log(`${area}: ${Object.entries(run.layers).map(([layer, counts]) => `${layer} caught ${counts?.caught ?? 0}, missed ${counts?.missed ?? 0}`).join('; ')}`);
