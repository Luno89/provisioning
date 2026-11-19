import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commitOf, HASHED_PATHS, OUT, record, ROOT, runsOf, sourceOf, type Timing } from './artifacts.js';
import { fileHashes } from './impact.js';
import { watchQuiet } from '../lib/quiet-watch.js';
import { WORKSPACES, type Workspace } from './workspaces.js';

interface Options { only: Workspace[]; out: string; cost: boolean }

function optionsFrom(args: readonly string[]): Options {
  const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  const names = value('--only')?.split(',');
  const only = names ? names.map((name) => WORKSPACES.find((workspace) => workspace.name === name) ?? (() => { throw new Error(`no workspace ${name}: ${WORKSPACES.map((workspace) => workspace.name).join(', ')}`); })()) : [...WORKSPACES];
  return { only, out: resolve(value('--out') ?? OUT), cost: args.includes('--cost') };
}

function suite(workspace: Workspace, log: string, coverage: string | undefined): { seconds: number; passed: boolean } {
  const started = Date.now();
  const output = openSync(log, 'w');
  const env = { ...process.env, ...(coverage ? { COUPLING_COVERAGE: coverage, TEMPORAL_DEBUG: '1' } : {}) };
  if (!coverage) delete env.COUPLING_COVERAGE;
  const watch = watchQuiet();
  let ran;
  try {
    ran = spawnSync('npm', ['run', 'test'], { cwd: join(ROOT, workspace.folder), env: { ...env, ...watch.env }, stdio: ['ignore', output, output] });
  } finally {
    watch.stop();
  }
  return { seconds: Math.round((Date.now() - started) / 100) / 10, passed: ran.status === 0 };
}

const options = optionsFrom(process.argv.slice(2));
const folder = join(options.out, 'in-process');
const runs = runsOf(options.out, 'in-process');
const source = sourceOf();
const files = fileHashes(ROOT, HASHED_PATHS);
const at = new Date().toISOString();
rmSync(folder, { recursive: true, force: true });
mkdirSync(runs, { recursive: true });

const timings: Record<string, Timing> = {};
for (const workspace of options.only) {
  const covered = suite(workspace, join(folder, `${workspace.name}.log`), runs);
  const plain = options.cost ? suite(workspace, join(folder, `${workspace.name}-plain.log`), undefined) : undefined;
  timings[workspace.name] = { seconds: covered.seconds, passed: covered.passed, ...(plain ? { plainSeconds: plain.seconds } : {}) };
  console.log(`${workspace.name}: ${covered.passed ? 'passed' : 'FAILED'} in ${covered.seconds}s with coverage${plain ? `, ${plain.seconds}s without` : ''}`);
}

if (sourceOf() !== source) throw new Error('the code changed while it was gathered, so what was gathered is not kept: gather again');
record(options.out, {
  artifact: 'in-process',
  source,
  commit: commitOf(),
  at,
  workspaces: options.only.map((workspace) => workspace.name),
  complete: options.only.length === WORKSPACES.length,
  timings,
  files,
});
if (Object.values(timings).some((timing) => !timing.passed)) process.exitCode = 1;
