export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function at(value: unknown, ...path: readonly (string | number)[]): unknown {
  let here = value;
  for (const key of path) {
    if (here === null || typeof here !== 'object') return undefined;
    here = (here as Record<string | number, unknown>)[key];
  }
  return here;
}

export function listAt(value: unknown, ...path: readonly (string | number)[]): unknown[] {
  const found = at(value, ...path);
  return Array.isArray(found) ? (found as unknown[]) : [];
}

export function recordAt(value: unknown, ...path: readonly (string | number)[]): JsonRecord {
  const found = at(value, ...path);
  return isJsonRecord(found) ? found : {};
}

export function textAt(value: unknown, ...path: readonly (string | number)[]): string | undefined {
  const found = at(value, ...path);
  return typeof found === 'string' ? found : undefined;
}

export function numberAt(value: unknown, ...path: readonly (string | number)[]): number | undefined {
  const found = at(value, ...path);
  return typeof found === 'number' ? found : undefined;
}
