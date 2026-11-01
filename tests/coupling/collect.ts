import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originalPositionFor, TraceMap, type SourceMapInput } from '@jridgewell/trace-mapping';

export interface Position { line: number; column: number }
export interface RanRange { start: Position; end: Position; count: number; fn?: string }
export interface Ran { testFile: string; files: Record<string, RanRange[]> }

interface V8Range { startOffset: number; endOffset: number; count: number }
interface V8Function { functionName: string; ranges: V8Range[] }
interface V8Script { scriptId: string; url: string; functions: V8Function[] }

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

export interface Collector { take(testFile: string): Promise<void> }

export async function startCollecting(options: { dir: string; root: string; keep: (file: string) => boolean }): Promise<Collector> {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Debugger.enable');
  await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  mkdirSync(options.dir, { recursive: true });
  return {
    async take(testFile) {
      const { result } = await session.post('Profiler.takePreciseCoverage') as { result: V8Script[] };
      const files: Record<string, RanRange[]> = {};
      for (const script of result) {
        if (!script.url.startsWith('file://')) continue;
        const path = fileURLToPath(script.url);
        const file = relative(options.root, path);
        if (!options.keep(file)) continue;
        const { scriptSource } = await session.post('Debugger.getScriptSource', { scriptId: script.scriptId }) as { scriptSource: string };
        const inline = INLINE_MAP.exec(scriptSource)?.[1];
        if (!inline) continue;
        const map = new TraceMap(JSON.parse(Buffer.from(inline, 'base64').toString('utf8')) as SourceMapInput);
        const starts = lineStarts(scriptSource);
        const original = (offset: number): Position | undefined => {
          const at = generatedAt(starts, offset);
          const found = originalPositionFor(map, { line: at.line, column: at.column });
          return found.line === null ? undefined : { line: found.line, column: found.column + 1 };
        };
        const ranges: RanRange[] = [];
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
      const ran: Ran = { testFile: relative(options.root, testFile), files };
      writeFileSync(join(options.dir, `${relative(options.root, testFile).replace(/[^A-Za-z0-9.-]+/g, '_')}.json`), JSON.stringify(ran));
      await session.post('Profiler.stopPreciseCoverage');
      session.disconnect();
    },
  };
}
