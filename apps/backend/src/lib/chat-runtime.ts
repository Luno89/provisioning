
import type { UnifiedFrame } from './chat-wire.js';

export interface TurnOutcome {
  answer: string;
  thinking: string;
  toolCalls: { id: string; name: string; args: string; ok: boolean; digest: string }[];
  enabledNow: string[];
  proposedTrees: unknown[];
  proposedSpecs: unknown[];
  exhaustedRounds: boolean;
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
  maxRounds?: number;
  onFrame?: (frame: UnifiedFrame) => void;
  onEachToolResult?: (frame: UnifiedFrame) => void;
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
