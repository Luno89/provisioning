import type { ToolEffect } from './action-gate.js';
import type { ToolRepositoryItem, ToolSurface } from './tool-seeds.js';

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

export function forSurface(rows: readonly ToolRepositoryItem[], surface: ToolSurface): ToolSchema[] {
  return rows.filter((r) => r.surfaces?.includes(surface)).map(asSchema);
}

export function namesForSurface(rows: readonly ToolRepositoryItem[], surface: ToolSurface): string[] {
  return rows.filter((r) => r.surfaces?.includes(surface)).map((r) => r.name);
}

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

export function offeredOn(rows: readonly ToolRepositoryItem[], surface: ToolSurface, name: string): boolean {
  return rows.some((r) => r.name === name && r.surfaces?.includes(surface));
}
