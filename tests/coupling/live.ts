import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMap, type SourceMapInput } from '@jridgewell/trace-mapping';
import { commitOf, OUT, record, ROOT, runsOf, sourceOf } from './artifacts.js';
import type { Position, Ran, RanRange } from './collect.js';
import { mappedFunctions, type V8Function } from './mapped.js';

export const LIVE = join(OUT, 'live');
export const POD_SOURCE = '/app';

export const checkoutPathOf = (path: string, root: string): string =>
  path === POD_SOURCE || path.startsWith(`${POD_SOURCE}/`) ? join(root, path.slice(POD_SOURCE.length)) : path;

export const STARTUP = 'startup';

export const runsInPod = (entry: string): boolean => entry.startsWith(`${POD_SOURCE}/`);

interface V8Script { url: string; functions: V8Function[] }
interface CachedMap { lineLengths: number[]; data: SourceMapInput }
export interface RawCoverage { result: V8Script[]; 'source-map-cache'?: Record<string, CachedMap> }

const raw = (dir: string): string => join(dir, 'raw');
const pids = (dir: string): string => join(dir, 'pids');

export type CmdlineOf = (pid: number, recordedCwd?: string) => string | undefined;

export const resolvedArgs = (args: readonly string[], cwd: string | undefined): string =>
  args.filter(Boolean).map((arg) => (arg.startsWith('-') || isAbsolute(arg) || cwd === undefined ? arg : resolve(cwd, arg))).join(' ');

const procCwd = (pid: number): string | undefined => {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
};

export const cmdlineOf: CmdlineOf = (pid, recordedCwd) => {
  let args: string[];
  try {
    args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch {
    return undefined;
  }
  return resolvedArgs(args, procCwd(pid) ?? recordedCwd);
};

const listedAs = (dir: string, pid: number): { entry: string; cwd?: string } => {
  let lines: string[];
  try {
    lines = readFileSync(join(pids(dir), String(pid)), 'utf8').split('\n').map((line) => line.trim());
  } catch {
    return { entry: '' };
  }
  return { entry: lines[0] ?? '', ...(lines[1] ? { cwd: lines[1] } : {}) };
};

const isOurs = (dir: string, pid: number, read: CmdlineOf): boolean => {
  const { entry, cwd } = listedAs(dir, pid);
  return entry !== '' && (read(pid, cwd) ?? '').includes(entry);
};

export const entriesOf = (dir = LIVE, read: CmdlineOf = cmdlineOf): string[] => liveProcesses(dir, read).map((pid) => listedAs(dir, pid).entry);

export function measuringProblem(entries: readonly string[]): string | undefined {
  if (entries.length === 0) return 'the dev stack is not measuring what the live suites run: stop it and start it with COUPLING_LIVE=1 npm run dev';
  if (!entries.some(runsInPod)) return 'the dev stack measures root and the hub but not your Koala\'s pods: stop it and start it again with COUPLING_LIVE=1 npm run dev, which applies the instance chart with dev.coverage';
  return undefined;
}

export function liveProcesses(dir = LIVE, read: CmdlineOf = cmdlineOf): number[] {
  if (!existsSync(pids(dir))) return [];
  return readdirSync(pids(dir)).filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => isOurs(dir, pid, read));
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

export async function sample(label: string | undefined, dir = LIVE, read: CmdlineOf = cmdlineOf): Promise<void> {
  const before = new Set(coverageFiles(dir));
  const asked = liveProcesses(dir, read);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(dir, 'request'), id);
  for (;;) {
    const waiting = asked.filter((pid) => isOurs(dir, pid, read) && answeredWith(dir, pid) !== id);
    if (waiting.length === 0) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const taken = coverageFiles(dir).filter((name) => !before.has(name));
  const startup = join(raw(dir), STARTUP);
  mkdirSync(startup, { recursive: true });
  writeFileSync(join(startup, 'label'), STARTUP);
  const running = new Set(liveProcesses(dir, read));
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

export function ranIn(coverage: RawCoverage, root: string): Record<string, RanRange[]> {
  const files: Record<string, RanRange[]> = {};
  for (const script of coverage.result) {
    if (!script.url.startsWith('file://')) continue;
    const file = relative(root, checkoutPathOf(fileURLToPath(script.url), root));
    if (!kept(file)) continue;
    const cached = coverage['source-map-cache']?.[script.url];
    if (!cached) continue;
    const map = new TraceMap(cached.data);
    const ranges = files[file] ?? [];
    for (const mapped of mappedFunctions(script.functions, map, (offset) => generatedAt(cached.lineLengths, offset))) {
      for (const { range } of mapped) ranges.push(range);
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
