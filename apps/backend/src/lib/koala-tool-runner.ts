/**
 * Executing the tools a general-chat turn calls.
 *
 * Separate from `runLeafTool` because the two share no vocabulary: that one acts on a branch and
 * every call is scoped to one, and none of this is. Ownership still comes from the session and never
 * from a tool argument — the same rule, for the same reason.
 *
 * ── WHAT THIS FILE IS NOW, AND WHAT IT DELIBERATELY IS NOT ──
 * It used to be a flat chain of `if (call.name === '…')` with every implementation inline. The
 * bodies now live in koala-tool-handlers.ts and the schema↔handler join lives in koala-tools.ts,
 * because keeping them apart let `web_search` and `fetch_web_page` exist as working handlers that
 * no model was ever offered. What is left here is the part that is the same for every tool:
 * parsing arguments, checking them against the declared schema, dispatching, and refusing safely.
 *
 * It is NOT a general HTTP or command gateway, and it must not become one. The abandoned harness-v2
 * branch shipped a `call_platform_api` tool that let the model issue any authenticated request —
 * any method, any path, DELETE included — with the caller's own session cookie. A dispatch table is
 * exactly the structure that makes adding such a tool feel natural, so: every tool here is a named
 * capability with a declared schema, ownership comes from `ctx`, and kubectl takes an argument
 * array that only this codebase constructs.
 */
import { KOALA_TOOLS, KOALA_TOOL_HANDLERS, KOALA_TOOL_EFFECTS, type KoalaToolName } from './koala-tools.js';
import { gate, ALL_EFFECTS, type ToolEffect } from './action-gate.js';
import { json, type KoalaToolContext, type KoalaToolResult } from './koala-tool-handlers.js';

export type { KoalaToolContext, KoalaToolResult };

/** Every tool name that can actually be dispatched. Derived from the table, never restated. */
export const KOALA_TOOL_NAMES = Object.keys(KOALA_TOOL_HANDLERS) as KoalaToolName[];

/**
 * Checks a call's argument TYPES against the schema the model was given.
 *
 * ── WHY IT DOES NOT CHECK REQUIRED FIELDS, HAVING TRIED ──
 * The first version refused a call whose `required` keys were missing, and it made the tool worse.
 * Every handler here already reports a missing field, and reports it far better, because it knows
 * what the field is FOR: `propose_spec` answers "every app must set a memory limit" and
 * `propose_tree` answers "goal is required — it is what the planner reads later". A generic
 * `"propose_spec" needs "resources"` pre-empted both, and the model lost the sentence that told it
 * what to do about it. Two tests caught this, which is what they are there for.
 *
 * So the division is: the HANDLER owns whether a call makes sense, and this owns only the thing a
 * handler cannot report well — an argument of the wrong shape, which would otherwise reach code
 * expecting a string and fail somewhere unrelated to the mistake. That also keeps this from
 * becoming the second, weaker copy of rules that live properly elsewhere.
 */
export function validateArgs(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  const schema = KOALA_TOOLS.find((t) => t.function.name === name)?.function.parameters as
    | { properties?: Record<string, { type?: string }> }
    | undefined;
  if (!schema) return undefined;

  for (const [key, value] of Object.entries(args)) {
    const want = schema.properties?.[key]?.type;
    if (!want || value === undefined || value === null) continue;
    const got = Array.isArray(value) ? 'array' : typeof value;
    // `integer` and `number` are both JS numbers; the schema distinction is not one JS can check.
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
    // Malformed arguments are the model's mistake to correct, not a reason to fail the turn.
    return json({ error: 'Could not read those arguments as JSON.' });
  }

  const handler = (KOALA_TOOL_HANDLERS as Record<string, typeof KOALA_TOOL_HANDLERS[KoalaToolName]>)[call.name];
  if (!handler) return json({ error: `No tool named "${call.name}".` });

  const complaint = validateArgs(call.name, args);
  if (complaint) return json({ error: complaint });

  /**
   * ── LAYER 2, AT THE ONLY PLACE EVERY CALL PASSES ──
   *
   * After argument checking so the model hears about a malformed call as a malformed call, and
   * before the handler so a refused tool has no chance to touch anything.
   *
   * `permitted` absent means every effect, which is what every existing caller wants and is not the
   * default-deny part: the deny is on the tool's DECLARATION, which is the thing an author can
   * forget. A context that wants less says so, and `READ_ONLY` is there for it.
   */
  const decision = gate(
    call.name,
    (KOALA_TOOL_EFFECTS as Record<string, ToolEffect | undefined>)[call.name],
    ctx.permitted ?? ALL_EFFECTS,
  );
  if (!decision.allowed) return json({ error: decision.reason });

  try {
    return await handler(ctx, args);
  } catch (err: any) {
    // A tool that throws must not take the conversation down with it.
    return json({ error: `That call failed: ${String(err?.message ?? err).slice(0, 300)}` });
  }
}
