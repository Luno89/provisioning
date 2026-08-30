import { ALL_TOOL_SEEDS } from './tool-seeds.js';
import { KOALA_TOOLS } from './koala-tools.js';
import { LEAF_TOOLS } from './leaf-tools.js';
import { SANDBOX_TOOLS } from './sandbox-tools.js';
import type { ToolEffect } from './action-gate.js';

export type ToolSchema = {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
};

const SCHEMA_BY_NAME = new Map<string, ToolSchema>();
for (const t of [...KOALA_TOOLS, ...LEAF_TOOLS, ...SANDBOX_TOOLS] as unknown as ToolSchema[]) {
  if (!SCHEMA_BY_NAME.has(t.function.name)) SCHEMA_BY_NAME.set(t.function.name, t);
}

const EFFECT_BY_NAME = new Map(ALL_TOOL_SEEDS.map((t) => [t.name, t.effect]));

export const ALL_TOOL_SCHEMAS: ToolSchema[] = [...SCHEMA_BY_NAME.values()];

export function schemasFor(names: readonly string[]): ToolSchema[] {
  const out: ToolSchema[] = [];
  for (const name of names) {
    const found = SCHEMA_BY_NAME.get(name);
    if (found) out.push(found);
  }
  return out;
}

export function effectOf(name: string): ToolEffect | undefined {
  return EFFECT_BY_NAME.get(name);
}

export function unknownTools(names: readonly string[]): string[] {
  return names.filter((n) => !SCHEMA_BY_NAME.has(n));
}
