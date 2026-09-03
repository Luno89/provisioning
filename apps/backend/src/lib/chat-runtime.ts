
import type { UnifiedFrame } from './chat-wire.js';
import type { BudgetConfig } from '@koala/harness-types';
import type { PostPass, StreamEvent } from './round-loop.js';

export interface TurnOutcome {
  answer: string;
  thinking: string;
  toolCalls: { id: string; name: string; args: string; ok: boolean; digest: string }[];
  enabledNow: string[];
  proposedTrees: unknown[];
  proposedSpecs: unknown[];
  exhaustedRounds: boolean;
  finishReason?: string;
  usage?: Record<string, unknown>;
  interrupted?: string;
}

export interface ChatRuntimeDeps {
  call: (req: { messages: unknown[]; tools: string[]; toolChoice?: 'none' }) => Promise<{
    ok: boolean; status?: number; body?: unknown;
  }>;
  executeTool: (call: { id: string; name: string; arguments: string }) => Promise<{
    content: string; ok?: boolean;
    enabled?: string; proposed?: unknown; proposedSpec?: unknown;
  }>;
  messages: unknown[];
  tools?: string[];
  trimPerRound?: (messages: unknown[]) => unknown[];
  /** Rounds of tool calling this turn may take. The pack's; there is no default here. */
  maxRounds: number;
  /** What the round loop records per round — also the pack's. */
  record: BudgetConfig['record'];
  onFrame?: (frame: UnifiedFrame) => void;
  onEachToolResult?: (frame: UnifiedFrame) => void;
  /** Recovery passes run once the loop settles — length-cap continuation, monologue recovery, etc. */
  postPasses?: PostPass[];
  /** Called on every underlying stream event; a non-empty return interrupts the turn immediately. */
  onStreamEvent?: (ev: StreamEvent) => string | void;
}

export interface ChatTurnResult {
  outcome: TurnOutcome;
  exhaustedRounds: boolean;
  answer: string;
  spoken: string;
}

export async function runChatTurn(deps: ChatRuntimeDeps): Promise<ChatTurnResult> {
  const {
    call, executeTool, messages, tools: initialTools = [],
    trimPerRound, maxRounds, record, onFrame: onFrameProp, onEachToolResult,
    postPasses, onStreamEvent,
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
    maxToolCallsPerMessage: record.callsPerRound,
    maxToolCallArgs: record.argChars,
    maxToolCallDigest: record.digestChars,
    messages,
    tools: initialTools,
    call: call as any,
    executeTool: wrappedExecuteTool as any,
    onEnabled: (name: string) => {
      emitFrame?.({ type: 'enabled', payload: [name] });
    },
    onExhausted: 'wrap-up',
    ...(postPasses ? { postPasses } : {}),
    emit: ((frame: any) => {
      if (frame.kind === 'content' || frame.kind === 'reasoning' || frame.kind === 'usage' || frame.kind === 'finish') {
        const interrupted = onStreamEvent?.(frame as StreamEvent);
        if (interrupted) return interrupted;
      }
      if (!emitFrame) return;
      if (frame.kind === 'content') {
        emitFrame({ type: 'content', delta: String(frame.text) });
      } else if (frame.kind === 'reasoning') {
        emitFrame({ type: 'thinking', delta: String(frame.text) });
      } else if (frame.kind === 'toolCall') {
        emitFrame({ type: 'toolAnnounce', payload: { id: frame.id, name: frame.name, args: frame.args } });
      } else if (frame.kind === 'toolResult') {
        emitFrame({ type: 'toolResult', payload: { id: frame.id, ok: frame.ok, digest: frame.digest } });
      } else if (frame.kind === 'interrupted') {
        emitFrame({ type: 'interrupted', payload: frame.reason });
      }
    }) as unknown as (f: any) => string | void,
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
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.interrupted ? { interrupted: result.interrupted } : {}),
  };

  return { outcome, exhaustedRounds: result.exhaustedRounds, answer: result.answer, spoken: result.spoken };
}
