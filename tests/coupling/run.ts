import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildGraph, isTest } from './graph.js';
import { judge } from './join.js';
import { levelFrom, runsIn, summary } from './report.js';
import { MATCHES, outsideEnds, projectsOf, WORKSPACES, workspaceOf, type Workspace } from './workspaces.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

interface Options { only: Workspace[]; out: string; cost: boolean; reuse: boolean }

function optionsFrom(args: readonly string[]): Options {
  const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  const names = value('--only')?.split(',');
  const only = names ? names.map((name) => WORKSPACES.find((workspace) => workspace.name === name) ?? (() => { throw new Error(`no workspace ${name}: ${WORKSPACES.map((workspace) => workspace.name).join(', ')}`); })()) : [...WORKSPACES];
  return { only, out: resolve(value('--out') ?? join(ROOT, 'tests', '.coupling')), cost: args.includes('--cost'), reuse: args.includes('--reuse') };
}

function timed(workspace: Workspace, log: string, coverage: string | undefined): { seconds: number; passed: boolean } {
  const started = Date.now();
  const output = openSync(log, 'w');
  const env = { ...process.env, ...(coverage ? { COUPLING_COVERAGE: coverage } : {}) };
  if (!coverage) delete env.COUPLING_COVERAGE;
  const ran = spawnSync('npm', ['run', 'test'], { cwd: join(ROOT, workspace.folder), env, stdio: ['ignore', output, output] });
  return { seconds: Math.round((Date.now() - started) / 100) / 10, passed: ran.status === 0 };
}

const options = optionsFrom(process.argv.slice(2));
const runs = join(options.out, 'runs');
const timings: Record<string, { withCoverage?: number; without?: number; passed: boolean }> = {};
if (!options.reuse) {
  rmSync(options.out, { recursive: true, force: true });
  mkdirSync(runs, { recursive: true });
  for (const workspace of options.only) {
    const covered = timed(workspace, join(options.out, `${workspace.name}.log`), runs);
    timings[workspace.name] = { withCoverage: covered.seconds, passed: covered.passed };
    if (options.cost) timings[workspace.name]!.without = timed(workspace, join(options.out, `${workspace.name}-plain.log`), undefined).seconds;
    console.log(`${workspace.name}: ${covered.passed ? 'passed' : 'FAILED'} in ${covered.seconds}s with coverage${options.cost ? `, ${timings[workspace.name]!.without}s without` : ''}`);
  }
}

const graphStarted = Date.now();
const graph = buildGraph({ projects: projectsOf(ROOT), root: ROOT, matches: MATCHES, extraEnds: outsideEnds(ROOT), calledFrom: (file) => !isTest(file) && workspaceOf(file) !== undefined });
const graphSeconds = Math.round((Date.now() - graphStarted) / 100) / 10;
const joinStarted = Date.now();
const judged = judge(graph, runsIn(runs), levelFrom(ROOT));
const joinSeconds = Math.round((Date.now() - joinStarted) / 100) / 10;

const text = summary(judged, graph);
writeFileSync(join(options.out, 'summary.txt'), `${text}\n`);
writeFileSync(join(options.out, 'report.json'), JSON.stringify({
  timings, graphSeconds, joinSeconds,
  unresolved: graph.unresolved,
  edges: judged.map((entry) => ({
    from: graph.units[entry.edge.from]?.name, site: `${entry.edge.site.file}:${entry.edge.site.line}`, to: entry.edge.to, through: entry.edge.through,
    crosses: entry.crosses, lowest: entry.lowest, withCallerAt: entry.withCallerAt, tests: entry.covered.length,
  })),
}));
console.log(`graph ${graphSeconds}s, join ${joinSeconds}s`);
console.log(text.split('\n').slice(0, 40).join('\n'));
