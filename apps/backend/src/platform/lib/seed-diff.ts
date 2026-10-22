/**
 * Whether a stored built-in still matches its seed.
 *
 * Seeding used to delete every built-in and write it back, so a row's `updatedAt` moved on each
 * run whether or not anything about it had changed. That is what made `seedAll` report writes on a
 * second run, and it quietly invalidated provenance: `AgentRequest.ranAs` records a pack's
 * `packUpdatedAt` to say which configuration a run used, and a bumped timestamp makes an unchanged
 * pack look edited.
 *
 * Timestamps are excluded from the comparison because they are the thing being protected.
 */
const TIMESTAMPS = new Set(['createdAt', 'updatedAt']);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, v]) => !TIMESTAMPS.has(key) && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, v]) => [key, canonical(v)]);
  }
  return value;
}

export function sameSeededRow(stored: unknown, desired: unknown): boolean {
  return JSON.stringify(canonical(stored)) === JSON.stringify(canonical(desired));
}
