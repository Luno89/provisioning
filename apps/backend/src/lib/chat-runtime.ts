/* ═══════════════ The chat runtime: persona-pack → runnable turn ═══════════════ */

import type { UnifiedFrame } from './chat-wire.js';

/**
 * ── THE ENGINE EMITS EVERYTHING ──
 *
 * It did not, and the docblock on `chat-wire.ts` said it did: "the ENGINE emits them all; the
 * SURFACE hides what a persona does not want, so nothing is ever dropped at the source." The code
 * dropped frames at the source, gated by nine `delivery` booleans — of which `plan` and `usage`
 * had no emitter at all and `telemetry` gated `interrupted`, a field declared, read once, and
 * assigned nowhere.
 *
 * Filtering here is also the wrong place on its own terms. The turn's thinking trace is persisted
 * onto the assistant message regardless of any flag, so a pack with `thinking: false` was already
 * STORING what it refused to stream — and turning the flag on later showed nothing for past turns,
 * because the data had never reached the client. Rendering is a decision the surface can revisit;
 * transmission is not.
 *
 * So every frame goes on the wire, one shape for every conversation, and a pack's delivery
 * preferences are applied where they can be changed without re-running the turn.
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
  outcome: TurnOutcome;
  exhaustedRounds: boolean;
  answer: string;
  spoken: string;
}

/**
 * Runs one turn, streaming every frame it produces through `onFrame`.
 *
 * The round-loop (`runToolRounds`) drives the machine; this adapts its events to the unified wire
 * and reports the semantic outcome so the caller can persist it. It takes no pack: with nothing
 * filtered, there is nothing here that varies by persona.
 */
export async function runChatTurn(deps: ChatRuntimeDeps): Promise<ChatTurnResult> {
  const {
    call, executeTool, messages, tools: initialTools = [],
    trimPerRound, maxRounds = 12, onFrame: onFrameProp, onEachToolResult,
  } = deps;

  const emitFrame = onFrameProp ?? onEachToolResult;

  const round = await import('./round-loop.js').then((m) => m.runToolRounds);

  const wrappedExecuteTool = async (callArg: { id: string; name: string; arguments: string }) => {
    const out = await executeTool(callArg);
    if (emitFrame) {
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
      emitFrame?.({ type: 'enabled', payload: [name] });
    },
    onExhausted: 'wrap-up',
    emit: ((frame: any) => {
      if (!emitFrame) return;
      if (frame.kind === 'content') {
        emitFrame({ type: 'content', delta: String(frame.text) });
      } else if (frame.kind === 'reasoning') {
        emitFrame({ type: 'thinking', delta: String(frame.text) });
      } else if (frame.kind === 'toolCall') {
        emitFrame({ type: 'toolAnnounce', payload: { id: frame.id, name: frame.name, args: frame.args } });
      } else if (frame.kind === 'toolResult') {
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

  return { outcome, exhaustedRounds: result.exhaustedRounds, answer: result.answer, spoken: result.spoken };
}
