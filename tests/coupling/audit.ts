import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commitOf, gatheredIn, keptAcrossGathers, OUT, ROOT, runsOf, sourceOf, usableIn, type Artifact } from './artifacts.js';
import { kept, lastRanLine, ranIn, unitsRanIn, type RanRecord } from './ran-history.js';
import { judge, unitLevels } from './join.js';
import { builtGraph } from './repo-graph.js';
import type { Ran } from './collect.js';
import { renderPage } from './render.js';
import { levelOf, runsIn, summary } from './report.js';
import { resultOf, type Result } from './result.js';
import { against, breaches, counted, judging, layerBreaches, movedIn, nearLines, neededTest, pruned, RULES, sameCallBefore, type Baseline, type Breach } from './rules.js';

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
const gatheredUsable = usableIn(gathered, sources);
const usable = options.require.length > 0 ? { ...gatheredUsable, artifacts: new Set([...gatheredUsable.artifacts].filter((artifact) => options.require.includes(artifact))) } : gatheredUsable;
for (const artifact of gatheredUsable.artifacts) if (!usable.artifacts.has(artifact)) console.log(`not used: ${artifact}, which was not asked for`);
const rules = judging(usable.artifacts);
for (const problem of usable.problems) console.log(`not used: ${problem}`);
for (const skipped of rules.skipped) console.log(`${skipped.rule} not judged: it needs ${skipped.missing.join(', ')}`);
const unmet = options.require.filter((artifact) => !gatheredUsable.artifacts.has(artifact));
if (unmet.length > 0) throw new Error(`required and not usable: ${unmet.join(', ')}`);

const graphStarted = Date.now();
const built = builtGraph(ROOT);
const graph = built.graph;
const graphSeconds = seconds(graphStarted);
const joinStarted = Date.now();
const runs = [...(usable.artifacts.has('in-process') ? runsIn(runsOf(options.out, 'in-process')) : []), ...(usable.artifacts.has('live') ? runsIn(runsOf(options.out, 'live')) : [])];
const judged = judge(graph, runs, levelOf);
const joinSeconds = seconds(joinStarted);

const breachesIn = (counted: readonly Ran[]) => [
  ...breaches(counted === runs ? judged : judge(graph, counted, levelOf), graph, rules.judged.filter((rule) => rule !== 'R5')),
  ...(rules.judged.includes('R5') ? layerBreaches(graph, unitLevels(graph, counted, levelOf)) : []),
];
const found = breachesIn(runs);
const belowLive = (): Breach[] => breachesIn(runs.filter((run) => levelOf(run.testFile) !== 'live'));
const write = (baseline: Baseline) => writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 1)}\n`);
const RAN_HISTORY = join(keptAcrossGathers(), 'ran.json');
const ranBefore = existsSync(RAN_HISTORY) ? JSON.parse(readFileSync(RAN_HISTORY, 'utf8')) as RanRecord[] : [];
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
  const lowering = belowLive();
  const moved = movedIn(before, found);
  for (const move of moved.moves) console.log(`moved: ${move.from} -> ${move.to} (${move.count})`);
  const baseline = options.prune ? pruned(moved.baseline, lowering, rules.judged, ranBefore[0]?.breaches) : moved.baseline;
  held = { kind: 'held', ...against(found, baseline, rules.judged, lowering) };
  if (options.prune && held.added.length === 0) write(baseline);
}

const commit = commitOf();
mkdirSync(keptAcrossGathers(), { recursive: true });
writeFileSync(RAN_HISTORY, JSON.stringify(kept(ranBefore, { commit, at: new Date().toISOString(), ran: ranIn(judged, graph), units: unitsRanIn(graph, runs), breaches: counted(belowLive()) })));

const result = resultOf({
  at: new Date().toISOString(), commit: commitOf(), source, gathered, problems: usable.problems, rules,
  seconds: { graph: graphSeconds, join: joinSeconds }, breaches: found, baseline: held, judged, graph,
});
writeFileSync(join(options.out, 'result.json'), JSON.stringify(result));
writeFileSync(join(options.out, 'report.html'), renderPage(result));
writeFileSync(join(options.out, 'summary.txt'), `${summary(judged, graph)}\n`);

console.log(`graph ${graphSeconds}s${built.reused ? ` (${built.reused.workspaces} of ${built.reused.of} workspaces reused)` : ''}, join ${joinSeconds}s; ${rules.judged.join(', ')} judged; ${found.length} breaches`);
if (held.kind === 'seeded') console.log(`baseline written: ${held.count} breaches`);
else if (held.kind === 'none') {
  console.log(`${BASELINE} does not exist: run once with --seed-baseline, every rule judged, to record today's breaches`);
  process.exitCode = 1;
} else {
  const before = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline : {};
  const sameCall = new Map(sameCallBefore(before, found, held.added).map((entry) => [entry.key, entry.was]));
  for (const breach of held.added) {
    console.log(`new ${breach.rule} at ${breach.at}: ${breach.key} (${breach.why})`);
    for (const line of breach.near ? nearLines(breach.near, breach.rule) : []) console.log(line);
    const needed = neededTest(breach);
    if (needed) console.log(needed);
    for (const was of sameCall.get(breach.key) ?? []) console.log(`  the baseline held this call under another target, now gone from it: ${was}`);
    if (breach.rule !== 'R4') console.log(lastRanLine(ranBefore, breach.key));
  }
  for (const entry of held.fixed) console.log(`fixed, prune it: ${entry.key} (${entry.was} -> ${entry.now})`);
  if (held.added.length > 0 || held.fixed.length > 0) process.exitCode = 1;
}
console.log(`report: ${join(options.out, 'report.html')}`);
