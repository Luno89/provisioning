import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { judge, reportOf, type Weights } from '@koala/coupling';
import { OUT, ROOT, runsOf } from './artifacts.js';
import { builtGraph } from './repo-graph.js';
import { runsIn } from './report.js';
import { codebaseOf } from './v2.js';

const WEIGHTS: Weights = { unit: 0.5, component: 0.6, contract: 0.7, container: 0.8, vm: 0.9 };

const git = (args: readonly string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const base = git(['merge-base', 'HEAD', 'main']).trim();
const changedFiles = [...new Set([...git(['diff', '--name-only', base]).split('\n'), ...git(['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean))];

const runs = (['in-process', 'live'] as const).map((artifact) => runsOf(OUT, artifact)).filter((dir) => existsSync(dir)).flatMap((dir) => runsIn(dir));
if (runs.length === 0) throw new Error(`no coverage records under ${OUT}: run npm run test:integration:coupled first`);
const judged = judge(codebaseOf(builtGraph(ROOT).graph, runs, changedFiles), WEIGHTS);
console.log(reportOf(judged, Number(process.argv[2] ?? 25)));
if (judged.blocking.length > 0) process.exitCode = 1;
