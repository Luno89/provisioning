import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commitOf, gatheredIn, OUT, ROOT, runsOf, sourceOf, usableIn, type Artifact } from './artifacts.js';
import { buildGraph, isTest } from './graph.js';
import { judge, unitLevels } from './join.js';
import { renderPage } from './render.js';
import { levelOf, runsIn, summary } from './report.js';
import { resultOf, type Result } from './result.js';
import { against, breaches, counted, judging, layerBreaches, pruned, RULES, type Baseline } from './rules.js';
import { MATCHES, outsideEnds, projectsOf, workspaceOf } from './workspaces.js';

const BASELINE = join(ROOT, 'tests', 'coupling', 'baseline.json');

interface Options { out: string; seed: boolean; prune: boolean; require: Artifact[] }

function optionsFrom(args: readonly string[]): Options {
  const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  return {
    out: resolve(value('--out') ?? OUT),
    seed: args.includes('--seed-baseline'),
    prune: args.includes('--prune'),
    require: (value('--require')?.split(',') ?? []) as Artifact[],
  };
}

const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;


const options = optionsFrom(process.argv.slice(2));
mkdirSync(options.out, { recursive: true });
const source = sourceOf();
const sources = { all: source, production: sourceOf(ROOT, 'production') };
const gathered = gatheredIn(options.out);
const usable = usableIn(gathered, sources);
const rules = judging(usable.artifacts);
for (const problem of usable.problems) console.log(`not used: ${problem}`);
for (const skipped of rules.skipped) console.log(`${skipped.rule} not judged: it needs ${skipped.missing.join(', ')}`);
const unmet = options.require.filter((artifact) => !usable.artifacts.has(artifact));
if (unmet.length > 0) throw new Error(`required and not usable: ${unmet.join(', ')}`);

const graphStarted = Date.now();
const graph = buildGraph({ projects: projectsOf(ROOT), root: ROOT, matches: MATCHES, extraEnds: outsideEnds(ROOT), calledFrom: (file) => !isTest(file) && workspaceOf(file) !== undefined });
const graphSeconds = seconds(graphStarted);
const joinStarted = Date.now();
const runs = [...(usable.artifacts.has('in-process') ? runsIn(runsOf(options.out, 'in-process')) : []), ...(usable.artifacts.has('live') ? runsIn(runsOf(options.out, 'live')) : [])];
const judged = judge(graph, runs, levelOf);
const joinSeconds = seconds(joinStarted);

const found = [...breaches(judged, graph, rules.judged.filter((rule) => rule !== 'R5')), ...(rules.judged.includes('R5') ? layerBreaches(graph, unitLevels(graph, runs, levelOf)) : [])];
const write = (baseline: Baseline) => writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 1)}\n`);
let held: Result['baseline'];
if (!existsSync(BASELINE) && !options.seed) {
  held = { kind: 'none' };
} else if (!existsSync(BASELINE)) {
  if (rules.judged.length !== RULES.length) throw new Error(`a baseline is seeded only with every rule judged; ${rules.skipped.map((skipped) => skipped.rule).join(', ')} were not`);
  write(counted(found));
  held = { kind: 'seeded', count: found.length };
} else {
  if (options.seed) throw new Error(`${BASELINE} exists: the baseline only shrinks, so it is never seeded again; use --prune`);
  const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
  const baseline = options.prune ? pruned(before, found, rules.judged) : before;
  if (options.prune) write(baseline);
  held = { kind: 'held', ...against(found, baseline, rules.judged) };
}

const result = resultOf({
  at: new Date().toISOString(), commit: commitOf(), source, gathered, problems: usable.problems, rules,
  seconds: { graph: graphSeconds, join: joinSeconds }, breaches: found, baseline: held, judged, graph,
});
writeFileSync(join(options.out, 'result.json'), JSON.stringify(result));
writeFileSync(join(options.out, 'report.html'), renderPage(result));
writeFileSync(join(options.out, 'summary.txt'), `${summary(judged, graph)}\n`);

console.log(`graph ${graphSeconds}s, join ${joinSeconds}s; ${rules.judged.join(', ')} judged; ${found.length} breaches`);
if (held.kind === 'seeded') console.log(`baseline written: ${held.count} breaches`);
else if (held.kind === 'none') {
  console.log(`${BASELINE} does not exist: run once with --seed-baseline, every rule judged, to record today's breaches`);
  process.exitCode = 1;
} else {
  for (const breach of held.added) console.log(`new ${breach.rule} at ${breach.at}: ${breach.key} (${breach.why})`);
  for (const entry of held.fixed) console.log(`fixed, prune it: ${entry.key} (${entry.was} -> ${entry.now})`);
  if (held.added.length > 0 || held.fixed.length > 0) process.exitCode = 1;
}
console.log(`report: ${join(options.out, 'report.html')}`);
