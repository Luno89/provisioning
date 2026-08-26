/* ═══════════════ The chat runtime: persona-pack → runnable turn ═══════════════ */

import type { DeliverySpec, PersonaPack } from './persona-pack.js';
import type { UnifiedFrame } from './chat-wire.js';

/**
 * Turns a completed round-loop result into the UnifiedFrames a persona's `delivery` surfaces.
 *
 * "What the user wants to see" is granular: the same turn renders as a rich assistant feed for
 * the Koala pack (deltas + thinking + tool pills + proposal cards) and as a transparency console
 * for the Harness pack (adds plan + usage, drops enable). The engine always EMITS everything; the
 * delivery filter decides what the surface puts on screen.
 */

/** The semantic result of one turn, as `runToolRounds` reports it. */
export interface TurnOutcome {
  answer: string;
  thinking: string;
  toolCalls: { id: string; name: string; args: string; ok: boolean; digest: string }[];
  enabledNow: string[];
  proposedTrees: unknown[];
  proposedSpecs: unknown[];
  exhaustedRounds: boolean;
  /** Optional subscription/control event, e.g. overthinking interruption. */
  interrupted?: string;
}

export function mapTurnToFrames(turn: TurnOutcome, delivery: DeliverySpec): UnifiedFrame[] {
  const frames: UnifiedFrame[] = [];

  if (delivery.content && turn.answer) {
    frames.push({ type: 'content', delta: String(turn.answer) });
  }
  if (delivery.thinking && turn.thinking) {
    frames.push({ type: 'thinking', delta: turn.thinking });
  }

  if (delivery.tools === 'semantic') {
    const announces = turn.toolCalls.map((c) => ({
      type: 'toolAnnounce' as const,
      payload: { id: c.id, name: c.name, args: c.args },
    }));
    frames.push(...announces);
    if (delivery.toolResults) {
      const results = turn.toolCalls.map((c) => ({
        type: 'toolResult' as const,
        payload: { id: c.id, ok: c.ok, digest: c.digest },
      }));
      frames.push(...results);
    }
  }

  if (delivery.proposals) {
    frames.push(
      ...turn.proposedTrees.map((tree) => ({ type: 'proposedTree' as const, payload: tree })),
      ...turn.proposedSpecs.map((spec) => ({ type: 'proposedSpec' as const, payload: spec })),
    );
  }

  if (delivery.enable && turn.enabledNow.length) {
    frames.push({ type: 'enabled', payload: turn.enabledNow });
  }

  if (delivery.telemetry && turn.interrupted) {
    frames.push({ type: 'interrupted', payload: turn.interrupted });
  }

  return frames;
}

/**
 * The full chat runtime: takes a persona pack and the pieces a handler must provide, and returns
 * a function that runs one turn over the shared round loop, emitting UnifiedFrames.
 *
 * The binder (a route) supplies:
 *   - modelService resolution (model/baseUrl/apiKey)
 *   - the `call` that POSTs to the provider
 *   - an `executeTool` that dispatches to the pack's toolset
 *   - per-round trim
 *
 * This module stays free of Express/db specifics so it is drivable in a unit test with a fake
 * model — the same shape as lib/round-loop.test.ts.
 */

export interface ChatRuntimeDeps {
  pack: PersonaPack;
  /** Builds and performs one provider request. Roundloop's call signature. */
  call: (req: { messages: unknown[]; tools: string[]; toolChoice?: 'none' }) => Promise<{
    ok: boolean; status?: number; body?: unknown;
  }>;
  /** Executes one tool call against the pack's environment. Returns text + effects. */
  executeTool: (call: { id: string; name: string; arguments: string }) => Promise<{
    content: string; ok?: boolean;
    enabled?: string; proposed?: unknown; proposedSpec?: unknown;
  }>;
  /** Initial transcript (system prompt + history), already assembled by the binder. */
  messages: unknown[];
  /** Tool names to offer on the first round. */
  tools?: string[];
  /** Per-round trim, e.g. koala's trimConversation. */
  trimPerRound?: (messages: unknown[]) => unknown[];
  maxRounds?: number;
  /** How to surface tool results live (the loop emits toolResult frames; we map). */
  onEachToolResult?: (frame: UnifiedFrame) => void;
}

export interface ChatTurnResult {
  frames: UnifiedFrame[];
  outcome: TurnOutcome;
  exhaustedRounds: boolean;
  answer: string;
  spoken: string;
}

/**
 * Runs one turn and returns both the raw outcome and the delivery-filtered frames for the surface.
 *
 * The round-loop (`runToolRounds`) drives the machine; the pack's `delivery` maps the result to the
 * frames the UI renders. Live streamed events (content/thinking) are forwarded through `onLive`.
 */
export async function runChatTurn(deps: ChatRuntimeDeps): Promise<ChatTurnResult> {
  const {
    pack, call, executeTool, messages, tools: initialTools = [],
    trimPerRound, maxRounds = 12, onEachToolResult,
  } = deps;

  const round = await import('./round-loop.js').then((m) => m.runToolRounds);

  const result = await round({
    maxRounds,
    messages,
    tools: initialTools,
    call: call as any,
    executeTool: executeTool as any,
    emit: ((frame: any) => {
      // Stream content live via the surface callback when present.
      if (frame.kind === 'content' && onEachToolResult) {
        onEachToolResult({ type: 'content', delta: String(frame.text) });
      }
    }) as unknown as (f: any) => void,
    ...(trimPerRound ? { trimPerRound } : {}),
  });

  const outcome: TurnOutcome = {
    answer: result.answer,
    thinking: result.thinking,
    toolCalls: result.toolCalls,
    enabledNow: result.enabledNow,
    proposedTrees: result.proposedTrees,
    proposedSpecs: result.proposedSpecs,
    exhaustedRounds: result.exhaustedRounds,
  };

  const frames = mapTurnToFrames(outcome, pack.delivery);
  return { frames, outcome, exhaustedRounds: result.exhaustedRounds, answer: result.answer, spoken: result.spoken };
}
