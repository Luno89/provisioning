import { RE2JS } from 're2js';

export const PATTERN_DIALECT = 'RE2: no lookarounds or backreferences';

export interface PatternFlags {
  multiline?: boolean;
  dotAll?: boolean;
  ignoreCase?: boolean;
}

export type LinearPattern = RE2JS;

export function linearPattern(pattern: string, flags: PatternFlags = {}): LinearPattern {
  return RE2JS.compile(pattern, (flags.multiline ? RE2JS.MULTILINE : 0) | (flags.dotAll ? RE2JS.DOTALL : 0) | (flags.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0));
}

export function firstMatch(pattern: LinearPattern, text: string): (string | undefined)[] | null {
  const matcher = pattern.matcher(text);
  if (!matcher.find()) return null;
  return Array.from({ length: matcher.groupCount() + 1 }, (_, index) => matcher.group(index) ?? undefined);
}
