import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heldTo, judge, learnedWeights, reportOf, untestedList, type UntestedList, type Weights } from '@koala/coupling';
import { DECISIONS } from '../alignment/decisions.js';
import { grants } from '../lib/baseline-growth.js';
import { acceptedUntested } from './accepted.js';
import { ARTIFACTS, gatheredIn, judgedGather, OUT, ROOT, runsIn, runsOf } from './artifacts.js';
import { builtGraph } from './repo-graph.js';
import { WORKSPACES } from './workspaces.js';
import { changedBase, codebaseOf, DEPENDENCIES, JUDGED_FROM, SHARING, versionsIn, type Since } from './v2.js';
import { AREAS, evidenceFrom, scoresIn, survivorsIn, type KeptRun, type MutationReport, type Unchecked } from './mutation.js';
import { backtest, faultEvidence, type KnownFault } from './faults.js';

const STARTING: Weights = { unit: 0.5, component: 0.6, contract: 0.7, container: 0.8, vm: 0.9 };
const EVIDENCE = join(ROOT, 'tests', 'coupling', 'evidence.json');
const kept = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) as KeptRun[] : [];
const CHURN_SINCE = '90 days ago';

const git = (args: readonly string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const lines = (text: string): string[] => text.split('\n').filter(Boolean);
const untracked = lines(git(['ls-files', '--others', '--exclude-standard']));
const changedSince = (commit: string): string[] => [...new Set([...lines(git(['diff', '--name-only', commit])), ...untracked])];
const modules = Object.keys(DEPENDENCIES);
const shipped = git(['merge-base', 'HEAD', 'origin/main']).trim();
const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', JUDGED_FROM, shipped], { cwd: ROOT, encoding: 'utf8' });
if (ancestry.status !== 0 && ancestry.status !== 1) throw new Error(`git could not say whether ${JUDGED_FROM} is shipped: ${ancestry.stderr.trim()}`);
const startShipped = ancestry.status === 0;

const sinceByTest = new Map<string, Since>();
const gathered = gatheredIn(OUT);
const runs = ARTIFACTS.flatMap((artifact) => {
  const dir = runsOf(OUT, artifact);
  const record = judgedGather(artifact, { runs: existsSync(dir), gathered: gathered[artifact] });
  if (!record) return [];
  const { commit } = record;
  const since: Since = { files: changedSince(commit), versions: versionsIn(git(['show', `${commit}:package-lock.json`]), modules) };
  const found = runsIn(dir);
  for (const run of found) sinceByTest.set(run.testFile, since);
  return found;
});
if (runs.length === 0) throw new Error(`no coverage records under ${OUT}: run npm run test:integration:coupled first`);

const churn: Record<string, number> = {};
for (const file of lines(git(['log', `--since=${CHURN_SINCE}`, '--name-only', '--format=']))) churn[file] = (churn[file] ?? 0) + 1;
const failedAt = JSON.parse(readFileSync(join(ROOT, 'tests', 'test-failures.json'), 'utf8')) as Record<string, string[]>;
const failures = Object.fromEntries(Object.entries(failedAt).map(([test, times]) => [test, times.length]));

const graph = builtGraph(ROOT, WORKSPACES, { withinFiles: true }).graph;
const unchecked: Record<string, Unchecked> = {};
const scores: Record<string, { caught: number; missed: number }> = {};
for (const { workspace, report } of Object.values(AREAS)) {
  const at = join(ROOT, report);
  if (!existsSync(at)) continue;
  const run = JSON.parse(readFileSync(at, 'utf8')) as MutationReport;
  Object.assign(unchecked, survivorsIn(run, workspace, Object.values(graph.units)));
  Object.assign(scores, scoresIn(run, workspace, Object.values(graph.units)));
}
const codebase = { ...codebaseOf(graph, runs, {
  changed: changedSince(changedBase({ shipped, startShipped })),
  since: (test) => sinceByTest.get(test),
  versions: versionsIn(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'), modules),
  churn,
  failures,
}), unchecked, scores };
const SHARED = { dependency: SHARING, composition: { target: 0.5 } };
const FAULTS = JSON.parse(readFileSync(join(ROOT, 'tests', 'coupling', 'faults.json'), 'utf8')) as KnownFault[];
const faultsByFile: Record<string, number> = {};
for (const fault of FAULTS) faultsByFile[fault.file] = (faultsByFile[fault.file] ?? 0) + 1;
codebase.history = { ...codebase.history, faults: faultsByFile };
const faultsFound = backtest(judge(codebase, STARTING, SHARED), FAULTS);
const learned = learnedWeights(STARTING, [...evidenceFrom(kept, Date.now()), ...faultEvidence(faultsFound)], { strength: 10, halfLife: 30 });
const WEIGHTS = learned.weights;
const judged = judge(codebase, WEIGHTS, SHARED);
const tested = backtest(judged, FAULTS);
const args = process.argv.slice(2);
const shown = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 25);
console.log(`layer weights, from ${kept.length} mutation runs: ${Object.entries(WEIGHTS).map(([layer, weight]) => `${layer} ${weight.toFixed(2)} (${learned.evidence[layer as keyof Weights].caught} caught, ${learned.evidence[layer as keyof Weights].missed} missed)`).join(', ')}`);
const failureLinks = judged.links.filter((link) => link.id.endsWith('!fails'));
const dependencyCalls = graph.edges.filter((edge) => edge.through === 'dependency');
console.log(`dependency failures: ${dependencyCalls.length} calls into a service, ${failureLinks.length} handle their failure where they are made, ${failureLinks.filter((link) => link.provenAt.length > 0).length} of those proven by a run that entered the handler at a layer where the service is real`);
console.log(reportOf(judged, shown));
console.log(`known faults, against the risk given their code: ${tested.inRiskierHalf} of ${tested.judged} in the riskier half`);
for (const entry of tested.faults) console.log(entry.found ? `  ${String(entry.percentile).padStart(3)}%  ${entry.fault.file}#${entry.fault.name} (rank ${entry.rank} of ${entry.ofAll}, run at ${entry.runAt.join(', ') || 'no layer'}): ${entry.fault.what}` : `    -   ${entry.fault.file}#${entry.fault.name}: not in the graph`);
if (judged.blocking.length > 0) process.exitCode = 1;

const LIST = join(ROOT, 'tests', 'coupling', 'untested.json');
const writeList = (list: UntestedList) => writeFileSync(LIST, `${JSON.stringify(list, null, 1)}\n`);
if (!existsSync(LIST)) {
  if (!args.includes('--seed')) throw new Error(`${LIST} does not exist: run once with --seed to record today's untested functions`);
  writeList(untestedList(judged.untested));
  console.log(`untested list written: ${judged.untested.length} functions`);
} else {
  if (args.includes('--seed')) throw new Error(`${LIST} exists: the untested list only shrinks, so it is never seeded again; use --prune`);
  const list = JSON.parse(readFileSync(LIST, 'utf8')) as UntestedList;
  if (args.includes('--accept')) {
    const accepted = acceptedUntested(list, untestedList(judged.untested), grants(DECISIONS));
    if ('refused' in accepted) throw new Error(accepted.refused);
    writeList(accepted.list);
    console.log(`untested list taken as it is today, as the register allows: ${Object.keys(accepted.list).length} functions`);
    process.exit(0);
  }
  const held = heldTo(judged.untested, list);
  for (const key of held.added) console.log(`new untested function: ${key}`);
  for (const fixed of held.fixed) console.log(`now tested or gone, prune it: ${fixed.key} (${fixed.was} -> ${fixed.now})`);
  if (args.includes('--prune') && held.added.length === 0) writeList(Object.fromEntries(Object.entries(list).flatMap(([key, was]) => { const now = held.fixed.find((fixed) => fixed.key === key)?.now ?? was; return now > 0 ? [[key, now]] : []; })));
  else if (held.added.length > 0 || held.fixed.length > 0) process.exitCode = 1;
}
