import { isRecord, listAt } from '../../platform/lib/json-shapes.js';
import { linearPattern, type LinearPattern } from '../../platform/lib/linear-patterns.js';

export type TemplateMarker = { contains: string } | { matches: string };

export interface ToolCallParser {
  parser: string;
  label: string;
  template: TemplateMarker[];
  names: string[];
  shipped: boolean;
}

export type ChatTemplate = { template: string } | { none: true };

export type ParserPick = { parser: string; from: 'template' | 'name' } | { problem: string };

const compiled = new Map<string, LinearPattern>();

function patternOf(source: string, ignoreCase: boolean): LinearPattern {
  const key = `${ignoreCase ? 'i' : 's'}:${source}`;
  let pattern = compiled.get(key);
  if (!pattern) {
    pattern = linearPattern(source, { ignoreCase });
    compiled.set(key, pattern);
  }
  return pattern;
}

const holds = (template: string, marker: TemplateMarker): boolean =>
  'contains' in marker ? template.includes(marker.contains) : patternOf(marker.matches, false).matcher(template).find();

const fitsTemplate = (row: ToolCallParser, template: string): boolean => row.template.length > 0 && row.template.every((marker) => holds(template, marker));

const fitsName = (row: ToolCallParser, model: string): boolean => row.names.some((name) => patternOf(name, true).matcher(model).find());

const parsersIn = (rows: readonly ToolCallParser[]): string[] => [...new Set(rows.map((row) => row.parser))];

const ambiguous = (model: string, rows: readonly ToolCallParser[], what: string): ParserPick =>
  ({ problem: `${model}${what} fits more than one tool call parser (${parsersIn(rows).join(', ')}): pick one, or turn tool calling off` });

function oneOf(model: string, candidates: readonly ToolCallParser[]): ParserPick | undefined {
  const parsers = parsersIn(candidates);
  if (parsers.length === 1) return { parser: parsers[0]!, from: 'template' };
  const named = candidates.filter((row) => fitsName(row, model));
  if (parsersIn(named).length === 1) return { parser: named[0]!.parser, from: 'template' };
  if (named.length > 1) return ambiguous(model, named, '\'s chat template');
  const generic = candidates.filter((row) => row.names.length === 0);
  if (parsersIn(generic).length === 1) return { parser: generic[0]!.parser, from: 'template' };
  return undefined;
}

export function parserFor(rows: readonly ToolCallParser[], chat: ChatTemplate, model: string): ParserPick {
  if ('none' in chat) {
    const named = rows.filter((row) => fitsName(row, model));
    if (parsersIn(named).length === 1) return { parser: named[0]!.parser, from: 'name' };
    if (named.length > 1) return ambiguous(model, named, '\'s name');
    return { problem: `${model} has no chat template on Hugging Face, and its name fits no tool call parser Koala knows: pick a parser, or turn tool calling off` };
  }
  const candidates = rows.filter((row) => fitsTemplate(row, chat.template));
  if (candidates.length === 0) return { problem: `${model}'s chat template has no tool call format Koala knows: pick a parser, or turn tool calling off` };
  return oneOf(model, candidates) ?? ambiguous(model, candidates, '\'s chat template');
}

export function parserProblem(rows: readonly ToolCallParser[], picked: string): string | undefined {
  return rows.some((row) => row.parser === picked) ? undefined : `${picked} is not a tool call parser Koala knows`;
}

const texts = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

function patternProblem(source: string, ignoreCase: boolean): boolean {
  try {
    patternOf(source, ignoreCase);
    return false;
  } catch {
    return true;
  }
}

function markerFrom(raw: unknown, parser: string, problems: string[]): TemplateMarker | undefined {
  if (isRecord(raw) && typeof raw.contains === 'string' && raw.contains && Object.keys(raw).length === 1) return { contains: raw.contains };
  if (isRecord(raw) && typeof raw.matches === 'string' && raw.matches && Object.keys(raw).length === 1) {
    if (patternProblem(raw.matches, false)) problems.push(`${parser}: the template marker ${raw.matches} is not an RE2 pattern`);
    return { matches: raw.matches };
  }
  problems.push(`${parser}: a template marker is a substring (contains) or a pattern (matches)`);
  return undefined;
}

function rowFrom(raw: unknown, problems: string[]): ToolCallParser | undefined {
  const parser = isRecord(raw) && typeof raw.parser === 'string' && raw.parser.trim() ? raw.parser.trim() : undefined;
  if (!parser || !isRecord(raw)) {
    problems.push('a parser has no name');
    return undefined;
  }
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) problems.push(`${parser}: it has no label`);
  const template = texts(raw.template).flatMap((marker) => markerFrom(marker, parser, problems) ?? []);
  const names = texts(raw.names).flatMap((name) => {
    if (typeof name !== 'string' || !name) {
      problems.push(`${parser}: a name is a pattern`);
      return [];
    }
    if (patternProblem(name, true)) problems.push(`${parser}: the name ${name} is not an RE2 pattern`);
    return [name];
  });
  return { parser, label, template, names, shipped: true };
}

export function toolCallParsersFrom(seed: unknown): ToolCallParser[] {
  const raws = listAt(seed, 'parsers');
  if (raws.length === 0) throw new Error('The tool call parsers to seed list no parsers');
  const problems: string[] = [];
  const rows = raws.flatMap((raw) => rowFrom(raw, problems) ?? []);
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.parser)) problems.push(`${row.parser} is named twice`);
    seen.add(row.parser);
  }
  if (problems.length) throw new Error(`The tool call parsers to seed cannot be read: ${problems.join('; ')}`);
  return rows;
}

const sameRow = (a: ToolCallParser, b: ToolCallParser): boolean => JSON.stringify(a) === JSON.stringify(b);

export function seedChanges(stored: readonly ToolCallParser[], wanted: readonly ToolCallParser[]): { save: ToolCallParser[]; remove: string[] } {
  const byParser = new Map(stored.map((row) => [row.parser, row]));
  const save = wanted.filter((row) => {
    const existing = byParser.get(row.parser);
    return !existing || (existing.shipped && !sameRow(existing, row));
  });
  const shippedNow = new Set(wanted.map((row) => row.parser));
  const remove = stored.filter((row) => row.shipped && !shippedNow.has(row.parser)).map((row) => row.parser);
  return { save, remove };
}

export interface VllmToolCallingAsked {
  vllmModel?: string | undefined;
  vllmToolCallingEnabled?: boolean | undefined;
  vllmToolCallParser?: string | undefined;
  vllmHfToken?: string | undefined;
}

export type VllmToolCalling =
  | { vllmToolCallingEnabled: false }
  | { vllmToolCallingEnabled: true; vllmToolCallParser: string }
  | { problem: string };

export const TOOL_CALLING_FIELDS = ['vllmModel', 'vllmToolCallingEnabled', 'vllmToolCallParser'] as const;
