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
  /** Live frame callback: emits UnifiedFrames as they arrive / execute in real time. */
  onFrame?: (frame: UnifiedFrame) => void;
  /** Backwards compatibility alias for onFrame. */
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
 * frames the UI renders. Live streamed events (content/thinking/tools/etc.) are forwarded through `onFrame`.
 */
export async function runChatTurn(deps: ChatRuntimeDeps): Promise<ChatTurnResult> {
  const {
    pack, call, executeTool, messages, tools: initialTools = [],
    trimPerRound, maxRounds = 12, onFrame: onFrameProp, onEachToolResult,
  } = deps;

  const emitFrame = onFrameProp ?? onEachToolResult;

  const round = await import('./round-loop.js').then((m) => m.runToolRounds);

  const wrappedExecuteTool = async (callArg: { id: string; name: string; arguments: string }) => {
    const out = await executeTool(callArg);
    if (pack.delivery.proposals && emitFrame) {
      if (out.proposed) emitFrame({ type: 'proposedTree', payload: out.proposed });
      if (out.proposedSpec) emitFrame({ type: 'proposedSpec', payload: out.proposedSpec });
      if ((out as any).proposedEscalation) emitFrame({ type: 'proposedEscalation', payload: (out as any).proposedEscalation });
      if ((out as any).proposedSecretRequest) emitFrame({ type: 'proposedSecretRequest', payload: (out as any).proposedSecretRequest });
    }
    return out;
  };

  const result = await round({
    maxRounds,
    messages,
    tools: initialTools,
    call: call as any,
    executeTool: wrappedExecuteTool as any,
    onEnabled: (name: string) => {
      if (pack.delivery.enable && emitFrame) {
        emitFrame({ type: 'enabled', payload: [name] });
      }
    },
    onExhausted: 'wrap-up',
    emit: ((frame: any) => {
      if (!emitFrame) return;
      if (frame.kind === 'content' && pack.delivery.content) {
        emitFrame({ type: 'content', delta: String(frame.text) });
      } else if (frame.kind === 'reasoning' && pack.delivery.thinking) {
        emitFrame({ type: 'thinking', delta: String(frame.text) });
      } else if (frame.kind === 'toolCall' && pack.delivery.tools === 'semantic') {
        emitFrame({ type: 'toolAnnounce', payload: { id: frame.id, name: frame.name, args: frame.args } });
      } else if (frame.kind === 'toolResult' && pack.delivery.tools === 'semantic' && pack.delivery.toolResults) {
        emitFrame({ type: 'toolResult', payload: { id: frame.id, ok: frame.ok, digest: frame.digest } });
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
