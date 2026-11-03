import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originalPositionFor, TraceMap, type SourceMapInput } from '@jridgewell/trace-mapping';
import { commitOf, OUT, record, ROOT, runsOf, sourceOf } from './artifacts.js';
import type { Position, Ran, RanRange } from './collect.js';
import { STARTUP } from './report.js';

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
const answeredWith = (dir: string, pid: number): string => {
  const file = join(pids(dir), `${pid}.taken`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

export const labelFile = (label: string): string => label.replace(/[^A-Za-z0-9.-]+/g, '_');

const pidOf = (coverageFile: string): number | undefined => {
  const found = /^coverage-(\d+)-/.exec(coverageFile)?.[1];
  return found === undefined ? undefined : Number(found);
};

const firstAnswerOf = (dir: string, pid: number): string => {
  const file = join(pids(dir), `${pid}.first`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

export async function sample(label: string | undefined, dir = LIVE): Promise<void> {
  const before = new Set(coverageFiles(dir));
  const asked = liveProcesses(dir);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(dir, 'request'), id);
  for (;;) {
    const waiting = asked.filter((pid) => alive(pid) && answeredWith(dir, pid) !== id);
    if (waiting.length === 0) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const taken = coverageFiles(dir).filter((name) => !before.has(name));
  const startup = join(raw(dir), STARTUP);
  mkdirSync(startup, { recursive: true });
  writeFileSync(join(startup, 'label'), STARTUP);
  const running = new Set(liveProcesses(dir));
  for (const kept of readdirSync(startup).filter((name) => name.endsWith('.json'))) {
    if (!running.has(pidOf(kept) ?? -1)) rmSync(join(startup, kept), { force: true });
  }
  let into: string | undefined;
  if (label !== undefined) {
    into = join(raw(dir), labelFile(label));
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, 'label'), label);
  }
  for (const name of taken) {
    const pid = pidOf(name);
    const first = pid !== undefined && firstAnswerOf(dir, pid) === id;
    if (first) renameSync(join(raw(dir), name), join(startup, name));
    else if (into) renameSync(join(raw(dir), name), join(into, name));
    else rmSync(join(raw(dir), name), { force: true });
  }
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
  record(OUT, { artifact: 'live', source: sourceOf(ROOT, 'production'), commit: commitOf(), at: new Date().toISOString(), workspaces: [...suites], complete: true, timings: {} });
}

async function main(command: string | undefined, label: string | undefined): Promise<void> {
  if (command === 'discard') await sample(undefined);
  else if (command === 'sample' && label) await sample(label);
  else if (command === 'convert') console.log(`${convert()} live suites converted`);
  else throw new Error('usage: live.ts discard | sample <label> | convert');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2], process.argv[3]).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
