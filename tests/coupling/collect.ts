import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMap, type SourceMapInput } from '@jridgewell/trace-mapping';
import { mappedFunctions, type V8Function } from './mapped.js';
import { ranIn, type RawCoverage } from './live.js';
import { chartRan } from './chart-trace.js';
import { shellRan } from './shell-trace.js';
import { writeRan } from './ran-record.js';

export interface Position { line: number; column: number }
export interface RanRange { start: Position; end: Position; count: number; fn?: string }
export interface Ran { testFile: string; files: Record<string, RanRange[]> }

interface V8Script { scriptId: string; url: string; functions: V8Function[] }
interface MappedScript { own: string; map: TraceMap; starts: number[] }

const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/m;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

function generatedAt(starts: number[], offset: number): Position {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - starts[low]! };
}

export interface Collector {
  childEnv: Record<string, string>;
  part(): Promise<void>;
  take(testFile: string): Promise<void>;
  sample(label: string, out: string): Promise<void>;
}

export async function startCollecting(options: { dir: string; root: string; keep: (file: string) => boolean; shellTrace?: string; chartTrace?: string; children?: string }): Promise<Collector> {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Debugger.enable');
  await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  mkdirSync(options.dir, { recursive: true });
  const { children } = options;
  if (children) mkdirSync(children, { recursive: true });
  const childEnv: Record<string, string> = children
    ? { NODE_V8_COVERAGE: children, NODE_OPTIONS: `--enable-source-maps ${process.env.NODE_OPTIONS ?? ''}`.trim() }
    : {};
  const childrenRan = (label: string, out: string): void => {
    if (!children || !existsSync(children)) return;
    readdirSync(children).filter((entry) => entry.endsWith('.json')).sort().forEach((name, index) => {
      const path = join(children, name);
      const files = Object.fromEntries(Object.entries(ranIn(JSON.parse(readFileSync(path, 'utf8')) as RawCoverage, options.root)).filter(([file]) => options.keep(file)));
      if (Object.keys(files).length > 0) writeRan(join(options.dir, out.replace(/\.json$/, `.child-${index}.json`)), { testFile: label, files });
      rmSync(path, { force: true });
    });
  };
  const mapped = new Map<string, MappedScript | undefined>();
  const mappedOf = async (script: V8Script): Promise<MappedScript | undefined> => {
    if (mapped.has(script.scriptId)) return mapped.get(script.scriptId);
    const own = script.url.startsWith('file://') ? relative(options.root, fileURLToPath(script.url)) : undefined;
    const wanted = own !== undefined && options.keep(own);
    const { scriptSource } = wanted ? await session.post('Debugger.getScriptSource', { scriptId: script.scriptId }) as { scriptSource: string } : { scriptSource: '' };
    const inline = INLINE_MAP.exec(scriptSource)?.[1];
    const found = own !== undefined && inline ? { own, map: new TraceMap(JSON.parse(Buffer.from(inline, 'base64').toString('utf8')) as SourceMapInput), starts: lineStarts(scriptSource) } : undefined;
    mapped.set(script.scriptId, found);
    return found;
  };
  let files: Record<string, RanRange[]> = {};
  const part = async (): Promise<void> => {
    const { result } = await session.post('Profiler.takePreciseCoverage') as { result: V8Script[] };
    for (const script of result) {
      const found = await mappedOf(script);
      if (!found) continue;
      const { own, map, starts } = found;
      for (const ranges of mappedFunctions(script.functions, map, (offset) => generatedAt(starts, offset))) {
        for (const { range } of ranges) (files[own] ??= []).push(range);
      }
    }
  };
  const write = async (label: string, out: string): Promise<void> => {
    await part();
    if (options.shellTrace) {
      Object.assign(files, shellRan(options.shellTrace, options.root));
      rmSync(options.shellTrace, { force: true });
    }
    if (options.chartTrace) {
      for (const [file, ranges] of Object.entries(chartRan(options.chartTrace))) (files[file] ??= []).push(...ranges);
      rmSync(options.chartTrace, { force: true });
    }
    writeRan(join(options.dir, out), { testFile: label, files });
    files = {};
    childrenRan(label, out);
  };
  return {
    childEnv,
    part,
    async take(testFile) {
      const label = relative(options.root, testFile);
      await write(label, `${label.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`);
      await session.post('Profiler.stopPreciseCoverage');
      session.disconnect();
    },
    sample: write,
  };
}
