import { decodedMappings, originalPositionFor, type TraceMap } from '@jridgewell/trace-mapping';
import type { Position, RanRange } from './collect.js';

export interface V8Range { startOffset: number; endOffset: number; count: number }
export interface V8Function { functionName: string; ranges: V8Range[] }

export interface Original extends Position { source: string | null }
export interface MappedRange { source: string | null; range: RanRange }

const at = (map: TraceMap, line: number, column: number): Original | undefined => {
  const found = originalPositionFor(map, { line, column });
  return found.line === null ? undefined : { source: found.source, line: found.line, column: found.column + 1 };
};

const after = (a: Position, b: Position): boolean => a.line > b.line || (a.line === b.line && a.column > b.column);

function firstWithin(map: TraceMap, from: Position, to: Position): Original | undefined {
  const exact = at(map, from.line, from.column);
  if (exact) return exact;
  const lines = decodedMappings(map);
  for (let line = from.line; line <= to.line; line += 1) {
    const segment = (lines[line - 1] ?? []).find((entry) => entry.length > 1 && (line > from.line || entry[0] >= from.column));
    if (!segment) continue;
    if (after({ line, column: segment[0] }, to)) return undefined;
    return at(map, line, segment[0]);
  }
  return undefined;
}

function lastWithin(map: TraceMap, from: Position, to: Position): Original | undefined {
  const exact = at(map, to.line, to.column);
  if (exact) return exact;
  const lines = decodedMappings(map);
  for (let line = to.line; line >= from.line; line -= 1) {
    const segment = (lines[line - 1] ?? []).findLast((entry) => entry.length > 1 && (line < to.line || entry[0] <= to.column));
    if (!segment) continue;
    if (after(from, { line, column: segment[0] })) return undefined;
    return at(map, line, segment[0]);
  }
  return undefined;
}

const sameSpan = (a: RanRange, b: RanRange): boolean =>
  a.start.line === b.start.line && a.start.column === b.start.column && a.end.line === b.end.line && a.end.column === b.end.column;

export function mappedFunctions(functions: readonly V8Function[], map: TraceMap, generatedAt: (offset: number) => Position): MappedRange[][] {
  const mapped = functions.map((fn) => {
    const ranges = fn.ranges.map((range, index): MappedRange | undefined => {
      const from = generatedAt(range.startOffset);
      const to = generatedAt(Math.max(range.startOffset, range.endOffset - 1));
      const start = firstWithin(map, from, to);
      const end = start && lastWithin(map, from, to);
      if (!start || !end || start.source !== end.source) return undefined;
      return { source: start.source, range: { start: { line: start.line, column: start.column }, end: { line: end.line, column: end.column }, count: range.count, ...(index === 0 ? { fn: fn.functionName } : {}) } };
    });
    return ranges[0] === undefined ? [] : ranges.filter((range): range is MappedRange => range !== undefined);
  });
  return mapped.filter((ranges, index) => {
    const own = ranges[0];
    const inner = mapped[index + 1]?.[0];
    return !(own && inner && ranges.length === 1 && own.source === inner.source && sameSpan(own.range, inner.range));
  });
}
