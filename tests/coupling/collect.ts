import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originalPositionFor, TraceMap, type SourceMapInput } from '@jridgewell/trace-mapping';
import { shellRan } from './shell-trace.js';

export interface Position { line: number; column: number }
export interface RanRange { start: Position; end: Position; count: number; fn?: string }
export interface Ran { testFile: string; files: Record<string, RanRange[]> }

interface V8Range { startOffset: number; endOffset: number; count: number }
interface V8Function { functionName: string; ranges: V8Range[] }
interface V8Script { scriptId: string; url: string; functions: V8Function[] }

const WORKFLOW_BUNDLE = /\/workflow-bundle-[0-9a-f]+\.js$/;
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
  take(testFile: string): Promise<void>;
  sample(label: string, out: string): Promise<void>;
}

export async function startCollecting(options: { dir: string; root: string; keep: (file: string) => boolean; shellTrace?: string }): Promise<Collector> {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Debugger.enable');
  await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  mkdirSync(options.dir, { recursive: true });
  const write = async (label: string, out: string): Promise<void> => {
    const { result } = await session.post('Profiler.takePreciseCoverage') as { result: V8Script[] };
    const files: Record<string, RanRange[]> = {};
    for (const script of result) {
      const bundled = WORKFLOW_BUNDLE.test(script.url);
      if (!bundled && !script.url.startsWith('file://')) continue;
      const own = bundled ? undefined : relative(options.root, fileURLToPath(script.url));
      if (own !== undefined && !options.keep(own)) continue;
      const { scriptSource } = await session.post('Debugger.getScriptSource', { scriptId: script.scriptId }) as { scriptSource: string };
      const inline = INLINE_MAP.exec(scriptSource)?.[1];
      if (!inline) continue;
      const map = new TraceMap(JSON.parse(Buffer.from(inline, 'base64').toString('utf8')) as SourceMapInput);
      const starts = lineStarts(scriptSource);
      const original = (offset: number): (Position & { file: string }) | undefined => {
        const at = generatedAt(starts, offset);
        const found = originalPositionFor(map, { line: at.line, column: at.column });
        if (found.line === null) return undefined;
        const file = own ?? (found.source ? relative(options.root, found.source.replace(/^webpack:\/\/[^/]*/, '')) : undefined);
        return file === undefined ? undefined : { file, line: found.line, column: found.column + 1 };
      };
      for (const fn of script.functions) {
        fn.ranges.forEach((range, index) => {
          const start = original(range.startOffset);
          const end = original(Math.max(range.startOffset, range.endOffset - 1));
          if (!start || !end || start.file !== end.file) return;
          if (own === undefined && !options.keep(start.file)) return;
          (files[start.file] ??= []).push({ start: { line: start.line, column: start.column }, end: { line: end.line, column: end.column }, count: range.count, ...(index === 0 ? { fn: fn.functionName } : {}) });
        });
      }
    }
    if (options.shellTrace) {
      Object.assign(files, shellRan(options.shellTrace, options.root));
      rmSync(options.shellTrace, { force: true });
    }
    const ran: Ran = { testFile: label, files };
    writeFileSync(join(options.dir, out), JSON.stringify(ran));
  };
  return {
    async take(testFile) {
      const label = relative(options.root, testFile);
      await write(label, `${label.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`);
      await session.post('Profiler.stopPreciseCoverage');
      session.disconnect();
    },
    sample: write,
  };
}
