import { ASSISTANT_ENTRIES } from './tool-handlers/assistant.js';
import { PLANNING_ENTRIES } from './tool-handlers/planning.js';
import { SANDBOX_ENTRIES } from './tool-handlers/sandbox.js';
import { gate, ALL_EFFECTS } from './action-gate.js';
import { effectOf, parametersOf } from './tool-catalogue.js';
import { withBuiltIns } from './ownership.js';
import {
  has, json, NEED_EXPLANATION,
  type ToolEntry, type ToolNeed, type ToolOutcome, type ToolRuntime,
} from './tool-runtime.js';
import type { ToolRepositoryItem } from './tool-seeds.js';

/**
 * Every tool this platform can run, by name.
 *
 * One map, because a tool is a tool. It used to be three -- the assistant's, the planner's and the
 * sandbox's -- with a `surfaces` field on the catalogue row deciding which map you were allowed to
 * reach. A pack's grant list is edited against the whole catalogue, so the two disagreed the moment
 * anyone granted across a boundary: the model was offered `get_leaf` and told `No tool named
 * "get_leaf"` when it obliged.
 *
 * Nothing here is grouped by caller. What a tool cannot do without, it declares in `needs`.
 */
export const TOOL_HANDLERS = {
  ...SANDBOX_ENTRIES,
  ...PLANNING_ENTRIES,
  ...ASSISTANT_ENTRIES,
};

export const TOOL_NAMES = Object.keys(TOOL_HANDLERS);

/** The tools that cannot run without a given resource. The honest answer to "what needs a sandbox". */
export function toolsNeeding(need: ToolNeed): string[] {
  return Object.entries(TOOL_HANDLERS).filter(([, e]) => e.needs.includes(need)).map(([name]) => name);
}

/** What this tool needs that this run has not got. Empty means it will run. */
export function unmetNeeds(rt: ToolRuntime, name: string): ToolNeed[] {
  const entry = (TOOL_HANDLERS as Record<string, ToolEntry>)[name];
  if (!entry) return [];
  return entry.needs.filter((need) => !has(rt, need));
}

export interface OfferedTools {
  /** Granted, and runnable here. */
  offered: string[];
  /** Granted, but withheld — with what each was missing, so it can be reported rather than guessed. */
  withheld: { name: string; missing: ToolNeed[] }[];
}

/**
 * Which of a pack's grants this run can actually honour.
 *
 * Offering a tool that cannot run is the same defect as dispatching one that cannot: the model
 * spends a round calling it and gets an apology. A grant list still decides WHAT a run may do --
 * this only drops what this particular run has no way of doing, and says what was dropped.
 *
 * A name that is not a tool at all is withheld with no missing resource: nothing implements it.
 */
export function offerableTools(rt: ToolRuntime, granted: readonly string[]): OfferedTools {
  const offered: string[] = [];
  const withheld: { name: string; missing: ToolNeed[] }[] = [];
  for (const name of granted) {
    if (!(name in TOOL_HANDLERS)) {
      withheld.push({ name, missing: [] });
      continue;
    }
    const missing = unmetNeeds(rt, name);
    if (missing.length) withheld.push({ name, missing });
    else offered.push(name);
  }
  return { offered, withheld };
}

/** One line naming what a run withheld and why, for a log that would otherwise say nothing. */
export function explainWithheld(withheld: OfferedTools['withheld']): string {
  return withheld
    .map(({ name, missing }) => `${name} (${missing.length ? missing.join(', ') : 'no such tool'})`)
    .join(', ');
}

export interface ToolCall {
  name: string;
  arguments: string;
}

/** Type-checks the arguments a model sent against the catalogue row's declared parameters. */
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

/**
 * The one dispatcher.
 *
 * A name either is a tool or is not. If it is, the only thing that can still stop it is a resource
 * this run does not have -- and then it says which, because "no such tool" was a lie that cost
 * hours to see through.
 */
export async function runTool(rt: ToolRuntime, call: ToolCall): Promise<ToolOutcome> {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments || '{}');
    args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return json({ error: 'Could not read those arguments as JSON.' });
  }

  const entry = (TOOL_HANDLERS as Record<string, ToolEntry>)[call.name];
  if (!entry) return json({ error: `There is no tool called "${call.name}".` });

  const rows = withBuiltIns(await rt.db.getTools(), rt.userId, (t) => t.name);

  const complaint = validateArgs(rows, call.name, args);
  if (complaint) return json({ error: complaint });

  const decision = gate(call.name, effectOf(rows, call.name), rt.permitted ?? ALL_EFFECTS);
  if (!decision.allowed) return json({ error: decision.reason });

  /**
   * A backstop. Every offer path drops what it cannot run, so a model should never reach this --
   * but a caller can dispatch a name it was not offered, and a resource can go away mid-run.
   */
  const missing = entry.needs.filter((need) => !has(rt, need));
  if (missing.length) {
    return json({
      error: `${call.name} needs ${missing.map((m) => NEED_EXPLANATION[m]).join(' and ')}, `
        + 'which this run does not have.',
    });
  }

  try {
    return await entry.run(rt, args);
  } catch (err: any) {
    return json({ error: `That call failed: ${String(err?.message ?? err).slice(0, 300)}` });
  }
}

/**
 * What a planning caller passes. It is the whole runtime now -- there is only one -- under the old
 * name, so callers and tests that speak of a "leaf tool context" still read correctly.
 */
export type LeafToolContext = ToolRuntime;
export type LeafToolCall = ToolCall;

/** Dispatch by name and take the text back. The shape planning callers already expect. */
export async function runLeafTool(ctx: LeafToolContext, call: LeafToolCall): Promise<string> {
  return (await runTool(ctx, call)).content;
}
