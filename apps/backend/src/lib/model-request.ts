import type { ModelKind } from '@koala/harness-types';
import { conversationSampling, toolTurnSampling } from './sampling.js';
import { applyOverrides, type Overrides } from './tunables.js';

export type TurnKind = 'conversation' | 'tool-turn';

export interface ModelRequestSpec {
  turn: TurnKind;
  kind?: ModelKind | undefined;
  messages: unknown;
  tools?: unknown;
  stream: boolean;
  maxTokens: number;
  reasoningEffort?: string | undefined;
  model?: string | undefined;
  overrides?: Overrides | undefined;
  extra?: Record<string, unknown> | undefined;
}

export interface BuiltModelRequest {
  body: Record<string, unknown>;
  unsupported: string[];
}

export function buildModelRequest(spec: ModelRequestSpec): BuiltModelRequest {
  const base: Record<string, unknown> = {
    ...(spec.turn === 'tool-turn' ? toolTurnSampling(spec.kind) : conversationSampling(spec.kind)),
    max_tokens: spec.maxTokens,
    ...(spec.reasoningEffort ? { reasoning_effort: spec.reasoningEffort } : {}),
    ...(spec.model ? { model: spec.model } : {}),
  };

  const { body, unsupported } = applyOverrides(base, spec.overrides ?? {}, spec.kind);

  return {
    body: {
      ...body,
      messages: spec.messages,
      ...(spec.tools ? { tools: spec.tools } : {}),
      stream: spec.stream,
      ...(spec.extra ?? {}),
    },
    unsupported,
  };
}
