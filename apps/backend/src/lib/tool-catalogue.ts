import type { ToolEffect } from './action-gate.js';
import type { ToolRepositoryItem } from './tool-seeds.js';

export type ToolSchema = {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
};

const EMPTY_PARAMS = { type: 'object', properties: {} };

export const asSchema = (row: ToolRepositoryItem): ToolSchema => ({
  type: 'function',
  function: {
    name: row.name,
    description: row.description,
    parameters: row.parameters ?? EMPTY_PARAMS,
  },
});

/**
 * The schemas for the named tools, in the order they were granted.
 *
 * This is the only way a runtime decides what to offer now. It used to be one of two, the other
 * being `forSurface` -- and because a pack's grant list is edited against the whole catalogue while
 * the surface was a field on the row, the two disagreed the moment anyone granted across them.
 */
export function schemasFor(rows: readonly ToolRepositoryItem[], names: readonly string[]): ToolSchema[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  return names.flatMap((n) => {
    const row = byName.get(n);
    return row ? [asSchema(row)] : [];
  });
}

export function effectOf(rows: readonly ToolRepositoryItem[], name: string): ToolEffect | undefined {
  return rows.find((r) => r.name === name)?.effect;
}

export function parametersOf(rows: readonly ToolRepositoryItem[], name: string): ToolRepositoryItem['parameters'] {
  return rows.find((r) => r.name === name)?.parameters;
}
