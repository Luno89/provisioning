import { execFileSync, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { RanRange } from './collect.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MARK = /^\++@@([^@]*)@@([^@]*)@@(\d+)@@ /;

const PRELUDE = [
  'COUPLING_SHELL_DIR=$PWD',
  'exec 19>>"$COUPLING_SHELL_TRACE"',
  'BASH_XTRACEFD=19',
  "PS4='+@@${COUPLING_SHELL_DIR}@@${COUPLING_SHELL_AS:-${BASH_SOURCE[0]-}}@@${LINENO}@@ '",
  'set -x',
  '',
].join('\n');

const quoted = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function writePrelude(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'shell-prelude.sh');
  if (!existsSync(file)) writeFileSync(file, PRELUDE);
  return file;
}

interface Tracing { trace: string; prelude: string }

let shIsBash: boolean | undefined;

function tracing(): Tracing | undefined {
  const trace = process.env.COUPLING_SHELL_TRACE;
  const prelude = process.env.COUPLING_SHELL_PRELUDE;
  if (!trace || !prelude) return undefined;
  shIsBash ??= execFileSync('sh', ['-c', 'printf %s "${BASH_VERSION-}"'], { encoding: 'utf8' }) !== '';
  if (!shIsBash) throw new Error('coupling coverage traces scripts with bash, and sh here is not bash');
  return { trace, prelude };
}

const startLine = (trace: Tracing, as?: string): string => `${as ? `COUPLING_SHELL_AS=${quoted(as)}; ` : ''}COUPLING_SHELL_TRACE=${quoted(trace.trace)}; . ${quoted(trace.prelude)}`;

export interface ShellRun { command: 'sh' | 'bash'; args: string[]; env: Record<string, string> }

export function runScript(file: string, args: readonly string[] = [], options: { posix?: boolean } = {}): ShellRun {
  const command = options.posix ? 'sh' : 'bash';
  const path = resolve(file);
  const trace = tracing();
  if (!trace) return { command, args: [path, ...args], env: {} };
  return { command, args: ['-c', `${startLine(trace)}; . "$0" "$@"`, path, ...args], env: { BASH_ENV: trace.prelude, COUPLING_SHELL_TRACE: trace.trace } };
}

export function spawnScript(file: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding & { posix?: boolean }): SpawnSyncReturns<string> {
  const { posix, ...spawnOptions } = options;
  const shell = runScript(file, args, posix ? { posix } : {});
  return spawnSync(shell.command, shell.args, { ...spawnOptions, env: { ...(spawnOptions.env ?? process.env), ...shell.env } });
}

export function functionLines(text: string, name: string): { from: number; to: number } {
  const lines = text.split('\n');
  const from = lines.findIndex((line) => new RegExp(`^${name}\\(\\) \\{`).test(line));
  if (from < 0) throw new Error(`no function ${name}`);
  const to = lines.findIndex((line, at) => at > from && line === '}');
  if (to < 0) throw new Error(`function ${name} has no closing brace at the start of a line`);
  return { from: from + 1, to: to + 1 };
}

export function scriptExcerpt(file: string, functions: readonly string[], then: string): string {
  const path = resolve(file);
  const lines = readFileSync(path, 'utf8').split('\n');
  const kept = new Set<number>();
  for (const name of functions) {
    const { from, to } = functionLines(lines.join('\n'), name);
    if (from === 1) throw new Error(`${name} starts on the first line, which the excerpt needs`);
    for (let line = from; line <= to; line += 1) kept.add(line);
  }
  const trace = tracing();
  const body = lines.map((line, at) => (kept.has(at + 1) ? line : ''));
  if (trace) body[0] = startLine(trace, path);
  return `${body.join('\n')}\n${then}`;
}

export function excerptEnv(): Record<string, string> {
  const trace = tracing();
  return trace ? { BASH_ENV: trace.prelude, COUPLING_SHELL_TRACE: trace.trace } : {};
}

function continued(lines: readonly string[]): number[] {
  const startOf: number[] = [];
  let start = 1;
  lines.forEach((line, at) => {
    startOf[at + 1] = start;
    if (!line.endsWith('\\')) start = at + 2;
  });
  return startOf;
}

export function shellRan(trace: string, root = ROOT): Record<string, RanRange[]> {
  if (!existsSync(trace)) return {};
  const counts = new Map<string, Map<number, number>>();
  for (const line of readFileSync(trace, 'utf8').split('\n')) {
    const found = MARK.exec(line);
    if (!found) continue;
    const [, dir, source, at] = found;
    if (!source || source === 'bash' || source === 'sh') continue;
    const file = relative(root, isAbsolute(source) ? source : join(dir!, source));
    if (file.startsWith('..') || !file.endsWith('.sh') || !existsSync(join(root, file))) continue;
    const lines = counts.get(file) ?? new Map<number, number>();
    lines.set(Number(at), (lines.get(Number(at)) ?? 0) + 1);
    counts.set(file, lines);
  }
  const ran: Record<string, RanRange[]> = {};
  for (const [file, lines] of counts) {
    const text = readFileSync(join(root, file), 'utf8').split('\n');
    const startOf = continued(text);
    const groups = new Map<number, number>();
    for (const [line, count] of lines) {
      if (line > text.length) continue;
      const start = startOf[line] ?? line;
      groups.set(start, (groups.get(start) ?? 0) + count);
    }
    ran[file] = [...groups].sort(([a], [b]) => a - b).map(([start, count]) => {
      let end = start;
      while (end < text.length && text[end - 1]!.endsWith('\\')) end += 1;
      return { start: { line: start, column: 1 }, end: { line: end, column: Number.MAX_SAFE_INTEGER }, count };
    });
  }
  return ran;
}
