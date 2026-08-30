import type { ModelKind, SamplingConfig } from '@koala/harness-types';
import { resolveSampling } from './pack-sampling.js';
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
  /**
   * The pack's sampler. Absent means send none — there is no base layer any more, so a caller with
   * no pack sends the engine's own defaults rather than values from a module nobody can edit.
   */
  sampling?: SamplingConfig | undefined;
}

export interface BuiltModelRequest {
  body: Record<string, unknown>;
  unsupported: string[];
}

export function buildModelRequest(spec: ModelRequestSpec): BuiltModelRequest {
  const sampled = resolveSampling(spec.sampling, spec.turn, spec.kind);
  const base: Record<string, unknown> = {
    ...sampled.body,
    max_tokens: spec.maxTokens,
    ...(spec.reasoningEffort ? { reasoning_effort: spec.reasoningEffort } : {}),
    ...(spec.model ? { model: spec.model } : {}),
  };

  const { body, unsupported } = applyOverrides(base, spec.overrides ?? {}, spec.kind);
  const allUnsupported = [...new Set([...sampled.unsupported, ...unsupported])];

  return {
    body: {
      ...body,
      messages: spec.messages,
      ...(spec.tools ? { tools: spec.tools } : {}),
      stream: spec.stream,
      ...(spec.extra ?? {}),
    },
    unsupported: allUnsupported,
  };
}
