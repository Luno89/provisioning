import { KOALA_TOOL_HANDLERS, type KoalaToolName } from './koala-tools.js';
import { gate, ALL_EFFECTS } from './action-gate.js';
import { effectOf, parametersOf } from './tool-catalogue.js';
import { withBuiltIns } from './ownership.js';
import type { ToolRepositoryItem } from './tool-seeds.js';
import { json, type KoalaToolContext, type KoalaToolResult } from './koala-tool-handlers.js';

export type { KoalaToolContext, KoalaToolResult };

export const KOALA_TOOL_NAMES = Object.keys(KOALA_TOOL_HANDLERS) as KoalaToolName[];

export function validateArgs(
  rows: readonly ToolRepositoryItem[],
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  const schema = parametersOf(rows, name) as
    | { properties?: Record<string, { type?: string }> }
    | undefined;
  if (!schema) return undefined;

  for (const [key, value] of Object.entries(args)) {
    const want = schema.properties?.[key]?.type;
    if (!want || value === undefined || value === null) continue;
    const got = Array.isArray(value) ? 'array' : typeof value;
    const ok = want === 'integer' ? got === 'number' : got === want;
    if (!ok) return `"${name}" wants "${key}" as ${want}, but got ${got}.`;
  }

  return undefined;
}

export async function runKoalaTool(
  ctx: KoalaToolContext,
  call: { name: string; arguments: string },
): Promise<KoalaToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    return json({ error: 'Could not read those arguments as JSON.' });
  }

  const handler = (KOALA_TOOL_HANDLERS as Record<string, typeof KOALA_TOOL_HANDLERS[KoalaToolName]>)[call.name];
  if (!handler) return json({ error: `No tool named "${call.name}".` });

  // The catalogue this user sees decides the schema and the effect — both are rows now.
  const rows = withBuiltIns(await ctx.db.getTools(), ctx.userId, (t) => t.name);

  const complaint = validateArgs(rows, call.name, args);
  if (complaint) return json({ error: complaint });

  const decision = gate(
    call.name,
    effectOf(rows, call.name),
    ctx.permitted ?? ALL_EFFECTS,
  );
  if (!decision.allowed) return json({ error: decision.reason });

  try {
    return await handler(ctx, args);
  } catch (err: any) {
    return json({ error: `That call failed: ${String(err?.message ?? err).slice(0, 300)}` });
  }
}
