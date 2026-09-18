export const TRACE_TEXT_LIMIT = 4000;
export const TRACE_DEPTH_LIMIT = 8;
export const TRACE_LIST_LIMIT = 200;

export function capForTrace(value: unknown, textLimit = TRACE_TEXT_LIMIT, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length <= textLimit ? value : `${value.slice(0, textLimit)}… (${value.length} characters)`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (depth >= TRACE_DEPTH_LIMIT) return '… (nested too deep to record)';

  if (Array.isArray(value)) {
    const kept = value.slice(0, TRACE_LIST_LIMIT).map((item) => capForTrace(item, textLimit, depth + 1));
    return value.length > TRACE_LIST_LIMIT ? [...kept, `… (${value.length - TRACE_LIST_LIMIT} more)`] : kept;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([name, entry]) => [name, capForTrace(entry, textLimit, depth + 1)] as const)
      .filter(([, entry]) => entry !== undefined),
  );
}
