import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originalPositionFor, TraceMap, type SourceMapInput } from '@jridgewell/trace-mapping';
import { commitOf, OUT, record, ROOT, runsOf, sourceOf } from './artifacts.js';
import type { Position, Ran, RanRange } from './collect.js';

export const LIVE = join(OUT, 'live');

interface V8Range { startOffset: number; endOffset: number; count: number }
interface V8Function { functionName: string; ranges: V8Range[] }
interface V8Script { url: string; functions: V8Function[] }
interface CachedMap { lineLengths: number[]; data: SourceMapInput }
interface RawCoverage { result: V8Script[]; 'source-map-cache'?: Record<string, CachedMap> }

const raw = (dir: string): string => join(dir, 'raw');
const pids = (dir: string): string => join(dir, 'pids');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function liveProcesses(dir = LIVE): number[] {
  if (!existsSync(pids(dir))) return [];
  return readdirSync(pids(dir)).filter((name) => /^\d+$/.test(name)).map(Number).filter(alive);
}

const coverageFiles = (dir: string): string[] => (existsSync(raw(dir)) ? readdirSync(raw(dir)).filter((name) => name.startsWith('coverage-') && name.endsWith('.json')) : []);
const takenAt = (dir: string, pid: number): number => {
  const file = join(pids(dir), `${pid}.taken`);
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
};

export const labelFile = (label: string): string => label.replace(/[^A-Za-z0-9.-]+/g, '_');

export async function sample(label: string | undefined, dir = LIVE): Promise<void> {
  const before = new Set(coverageFiles(dir));
  const asked = liveProcesses(dir).map((pid) => ({ pid, was: takenAt(dir, pid) }));
  for (const { pid } of asked) process.kill(pid, 'SIGUSR2');
  for (;;) {
    const waiting = asked.filter(({ pid, was }) => alive(pid) && takenAt(dir, pid) === was);
    if (waiting.length === 0) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const taken = coverageFiles(dir).filter((name) => !before.has(name));
  if (label === undefined) {
    for (const name of taken) rmSync(join(raw(dir), name), { force: true });
    return;
  }
  const into = join(raw(dir), labelFile(label));
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, 'label'), label);
  for (const name of taken) renameSync(join(raw(dir), name), join(into, name));
}

function generatedAt(lineLengths: readonly number[], offset: number): Position {
  let start = 0;
  for (let line = 0; line < lineLengths.length; line += 1) {
    const end = start + lineLengths[line]! + 1;
    if (offset < end) return { line: line + 1, column: offset - start };
    start = end;
  }
  return { line: lineLengths.length, column: 0 };
}

const kept = (file: string): boolean => !file.startsWith('..') && !file.includes('node_modules') && !/\.test\.tsx?$/.test(file) && !file.startsWith('tests/');

function ranIn(coverage: RawCoverage, root: string): Record<string, RanRange[]> {
  const files: Record<string, RanRange[]> = {};
  for (const script of coverage.result) {
    if (!script.url.startsWith('file://')) continue;
    const file = relative(root, fileURLToPath(script.url));
    if (!kept(file)) continue;
    const cached = coverage['source-map-cache']?.[script.url];
    if (!cached) continue;
    const map = new TraceMap(cached.data);
    const original = (offset: number): Position | undefined => {
      const at = generatedAt(cached.lineLengths, offset);
      const found = originalPositionFor(map, at);
      return found.line === null ? undefined : { line: found.line, column: found.column + 1 };
    };
    const ranges = files[file] ?? [];
    for (const fn of script.functions) {
      fn.ranges.forEach((range, index) => {
        const start = original(range.startOffset);
        const end = original(Math.max(range.startOffset, range.endOffset - 1));
        if (!start || !end) return;
        ranges.push({ start, end, count: range.count, ...(index === 0 ? { fn: fn.functionName } : {}) });
      });
    }
    files[file] = ranges;
  }
  return files;
}

export function convert(dir = LIVE, root = ROOT): number {
  const runs = runsOf(OUT, 'live');
  rmSync(runs, { recursive: true, force: true });
  mkdirSync(runs, { recursive: true });
  let written = 0;
  for (const name of existsSync(raw(dir)) ? readdirSync(raw(dir)) : []) {
    const folder = join(raw(dir), name);
    if (!statSync(folder).isDirectory()) continue;
    const label = readFileSync(join(folder, 'label'), 'utf8');
    const files: Record<string, RanRange[]> = {};
    for (const file of readdirSync(folder).filter((entry) => entry.endsWith('.json'))) {
      for (const [path, ranges] of Object.entries(ranIn(JSON.parse(readFileSync(join(folder, file), 'utf8')) as RawCoverage, root))) {
        files[path] = [...(files[path] ?? []), ...ranges];
      }
    }
    const ran: Ran = { testFile: label, files };
    writeFileSync(join(runs, `${name}.json`), JSON.stringify(ran));
    written += 1;
  }
  return written;
}

export function recordLive(suites: readonly string[]): void {
  record(OUT, { artifact: 'live', source: sourceOf(), commit: commitOf(), at: new Date().toISOString(), workspaces: [...suites], complete: true, timings: {} });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, label] = process.argv.slice(2);
  if (command === 'discard') await sample(undefined);
  else if (command === 'sample' && label) await sample(label);
  else if (command === 'convert') console.log(`${convert()} live suites converted`);
  else throw new Error('usage: live.ts discard | sample <label> | convert');
}
