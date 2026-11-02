import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ran } from './collect.js';
import type { Graph } from './graph.js';
import { judge } from './join.js';
import { shellEnds } from './shell-edges.js';
import { runScript, scriptExcerpt, shellRan, writePrelude, type ShellRun } from './shell-trace.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = 'tests/coupling/fixture-shell/scripts/report.sh';
const CHILD = 'tests/coupling/fixture-shell/scripts/child.sh';

const ranLines = (ran: ReturnType<typeof shellRan>, file: string) => (ran[file] ?? []).map((range) => `${range.start.line}-${range.end.line}`);

describe('scripts run under tests, traced line by line', () => {
  const kept = { trace: process.env.COUPLING_SHELL_TRACE, prelude: process.env.COUPLING_SHELL_PRELUDE };
  let dir: string;
  let bin: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shell-trace-'));
    bin = mkdtempSync(join(tmpdir(), 'shell-bin-'));
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf "curl %s\\n" "$*"\n', { mode: 0o755 });
    process.env.COUPLING_SHELL_TRACE = join(dir, 'run.trace');
    process.env.COUPLING_SHELL_PRELUDE = writePrelude(dir);
  });
  afterEach(() => {
    for (const [name, value] of [['COUPLING_SHELL_TRACE', kept.trace], ['COUPLING_SHELL_PRELUDE', kept.prelude]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const run = (shell: ShellRun, cwd = ROOT) => spawnSync(shell.command, shell.args, { cwd, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, ROOT_URL: 'http://root', ...shell.env } });

  it('records every line a script ran, a command over several lines as one, and a script it starts', () => {
    const ran = run(runScript(join(ROOT, SCRIPT), [], { posix: true }));
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toBe('start\ncurl -sS -d hello http://root/api/things\nchild\n');
    expect(ran.stderr).toBe('');
    const lines = shellRan(join(dir, 'run.trace'), ROOT);
    expect(ranLines(lines, SCRIPT)).toEqual(['2-2', '4-4', '7-8', '9-9', '14-14', '15-15', '16-16']);
    expect(ranLines(lines, CHILD)).toEqual(['2-2']);
  });

  it('keeps a script\'s own line numbers when only some of its functions are run, from any folder', () => {
    const ran = run({ command: 'sh', args: ['-c', scriptExcerpt(join(ROOT, SCRIPT), ['post'], 'set -eu\npost from-an-excerpt')], env: {} }, bin);
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toBe('curl -sS -d from-an-excerpt http://root/api/things\n');
    expect(ranLines(shellRan(join(dir, 'run.trace'), ROOT), SCRIPT)).toEqual(['7-8', '9-9']);
  });

  it('runs scripts untouched when coverage is off', () => {
    delete process.env.COUPLING_SHELL_TRACE;
    expect(runScript(join(ROOT, SCRIPT), ['a'])).toEqual({ command: 'bash', args: [join(ROOT, SCRIPT), 'a'], env: {} });
    const excerpt = scriptExcerpt(join(ROOT, SCRIPT), ['say'], 'say hi');
    expect(excerpt.split('\n').slice(0, 6)).toEqual(['', '', 'say() {', "  printf '%s\\n' \"$1\"", '}', '']);
    expect(readFileSync(join(ROOT, SCRIPT), 'utf8').split('\n').length + 1).toBe(excerpt.split('\n').length);
  });

  it('covers a script\'s curl only when the test ran that line and the handler it reaches', () => {
    run(runScript(join(ROOT, SCRIPT)));
    const handler = 'apps/backend/src/x/things.ts';
    const ends = shellEnds(ROOT, SCRIPT);
    expect(ends.map((end) => `${end.unit.line} ${end.name}`)).toEqual(['7 POST /api/things', '12 GET /api/never']);
    const graph: Graph = {
      units: {
        sent: { id: 'sent', file: SCRIPT, name: 'post', line: 7, column: 1, start: 0, end: 0, inTest: false },
        never: { id: 'never', file: SCRIPT, name: 'never', line: 12, column: 1, start: 0, end: 0, inTest: false },
        handler: { id: 'handler', file: handler, name: 'things', line: 1, column: 1, start: 0, end: 0, inTest: false },
      },
      edges: ends.map((end) => ({ from: end.unit.line === 7 ? 'sent' : 'never', site: { file: SCRIPT, line: end.unit.line, column: 1, start: 0, end: 0 }, to: ['handler'], through: 'http' as const })),
      unresolved: [],
      unmatched: [],
    };
    const runs: Ran[] = [{ testFile: 'x.test.ts', files: { ...shellRan(join(dir, 'run.trace'), ROOT), [handler]: [{ start: { line: 1, column: 1 }, end: { line: 9, column: 1 }, count: 1, fn: 'things' }] } }];
    expect(judge(graph, runs, () => 'component').map((entry) => entry.covered.length)).toEqual([1, 0]);
  });
});

describe('every test that runs one of Koala\'s scripts', () => {
  const RUNS_A_SHELL = /\b(spawn|spawnSync|execFile|execFileSync)\(\s*'(sh|bash)'/;
  const NAMES_A_SCRIPT = /scripts\/[\w./-]*\.sh\b|ROOT_NODE\b/;
  const files = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((file) => file && !file.startsWith('tests/coupling/'));

  it('runs it through shell-trace, so its lines count as covered', () => {
    const raw = files.filter((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      return RUNS_A_SHELL.test(text) && NAMES_A_SCRIPT.test(text) && !/from '[./]*(tests\/)?coupling\/shell-trace\.js'/.test(text);
    });
    expect(raw).toEqual([]);
  });
});
