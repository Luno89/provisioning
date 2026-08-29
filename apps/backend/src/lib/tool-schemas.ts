import { KOALA_TOOLS } from './koala-tools.js';
import { LEAF_TOOLS } from './leaf-tools.js';
import { SANDBOX_TOOLS } from './sandbox-tools.js';

export type ToolSchema = { type: 'function'; function: { name: string; description?: string; parameters?: unknown } };

const BY_NAME = new Map<string, ToolSchema>();
for (const t of [...KOALA_TOOLS, ...LEAF_TOOLS, ...SANDBOX_TOOLS] as unknown as ToolSchema[]) {
  if (!BY_NAME.has(t.function.name)) BY_NAME.set(t.function.name, t);
}

export const ALL_TOOL_SCHEMAS: ToolSchema[] = [...BY_NAME.values()];

export function schemasFor(names: readonly string[]): ToolSchema[] {
  const out: ToolSchema[] = [];
  for (const name of names) {
    const found = BY_NAME.get(name);
    if (found) out.push(found);
  }
  return out;
}

export function unknownTools(names: readonly string[]): string[] {
  return names.filter((n) => !BY_NAME.has(n));
}
