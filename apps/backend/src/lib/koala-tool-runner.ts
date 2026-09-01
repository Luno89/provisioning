import { ASSISTANT_ENTRIES } from './tool-handlers/assistant.js';
import { runTool } from './tool-registry.js';
import type { KoalaToolContext, KoalaToolResult } from './koala-tool-handlers.js';

export type { KoalaToolContext, KoalaToolResult };

/** The tools whose handlers live in `koala-tool-handlers.ts`. Not a limit on what a chat may run. */
export const KOALA_TOOL_NAMES = Object.keys(ASSISTANT_ENTRIES);

/**
 * Dispatch from a chat.
 *
 * A thin call into the one registry. It used to be a dispatcher of its own, with its own map of 25
 * names and its own copy of the argument check and the effect gate -- so a chat pack granting
 * anything outside that map had it offered to the model and refused on the way back, as
 * `No tool named "get_leaf"`. There is nothing left here to disagree with.
 */
export async function runKoalaTool(
  ctx: KoalaToolContext,
  call: { name: string; arguments: string },
): Promise<KoalaToolResult> {
  return runTool(ctx, call);
}
