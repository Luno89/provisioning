/* ═══════════════ The single unified chat-stream wire ═══════════════ */

/**
 * One wire contract for every chat conversation, replacing the two previous envelopes:
 *   /api/chat       forwarded the provider's raw OpenAI frames verbatim
 *   /api/koala/chat re-encoded into its own {delta}/{reasoning}/{toolCall}/{toolResult}
 *
 * This is the merge. Every frame is a typed `{ type, payload }`. The provider's delta rides
 * inside a `content` frame INTACT (nothing re-encoded and lost), and the server interleaves
 * semantic frames the raw wire never had — tool lifecycle, proposals, enabled, plan, usage.
 *
 * A persona pack's `delivery` spec (lib/persona-pack.ts) declares which frame types the UI
 * surface renders. The ENGINE emits them all; the SURFACE hides what a persona does not want,
 * so nothing is ever dropped at the source.
 */
import type { ToolCall } from './leaf-tools.js';

/** The raw provider delta, forwarded intact inside the content frame. */
export interface ContentDelta {
  content?: string;
  reasoning_content?: string;
  [key: string]: unknown; // unknown provider fields survive, not dropped
}

export type UnifiedFrame =
  | { type: 'content'; delta: ContentDelta }
  | { type: 'thinking'; text: string }
  | { type: 'toolAnnounce'; id: string; name: string; args: string }
  | { type: 'toolResult'; id: string; ok: boolean; digest: string }
  | { type: 'proposedTree'; tree: unknown }
  | { type: 'proposedSpec'; spec: unknown }
  | { type: 'enabled'; services: string[] }
  | { type: 'plan'; content: string }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'interrupted'; reason: string };

/** All the frame types, so a persona-pack's delivery can be validated against them. */
export const UNIFIED_FRAME_TYPES = [
  'content', 'thinking', 'toolAnnounce', 'toolResult',
  'proposedTree', 'proposedSpec', 'enabled', 'plan', 'usage', 'interrupted',
] as const;

export function isUnifiedFrame(v: unknown): v is UnifiedFrame {
  return (
    typeof v === 'object' &&
    v !== null &&
    'type' in (v as any) &&
    (UNIFIED_FRAME_TYPES as readonly string[]).includes((v as any).type)
  );
}

/**
 * A frame the engine emits, which the surface then filters by the pack's delivery flags.
 * Tool results arrive from the round-loop as ToolExecResult-ish; converted here.
 */
export function toolResultFrame(
  id: string,
  name: string,
  ok: boolean,
  digest: string,
): UnifiedFrame {
  return { type: 'toolResult', id, ok, digest };
}

/** The complete set a handler may produce in one turn. */
export interface TurnFrames {
  content: ContentDelta[];
  thinking: string[];
  toolAnnounces: { id: string; name: string; args: string }[];
  toolResults: { id: string; ok: boolean; digest: string }[];
  proposedTrees: unknown[];
  proposedSpecs: unknown[];
  enabled: string[];
  plans: string[];
  usages: Record<string, unknown>[];
  interrupted?: string;
}
