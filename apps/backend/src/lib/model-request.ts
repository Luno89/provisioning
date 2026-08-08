/**
 * Building the body of a model call — once, so nine call sites cannot disagree about it.
 *
 * ── WHY THIS EXISTS ──
 * Assembling a request means getting three things right at the same time: which built-in sampling
 * profile the turn deserves, the precedence between that and whatever the profile/persona/request
 * asked for, and WHERE each override belongs on the wire. Nine sites did it inline and no two did
 * it identically. The failures were silent every time:
 *
 *   · Four chat call sites spread `conversationSampling` LAST, which overwrote the adopted
 *     profile for every key it sets. The profile zeroes `frequency_penalty` and
 *     `presence_penalty` because those stop this model emitting a tool call at all — so chat
 *     returned empty replies and the fix that "made chat honour the profile" did nothing.
 *   · Three of those four also spread the raw request instead of the resolved chain, so they never
 *     honoured a profile or persona in the first place.
 *   · The chat path filtered overrides by hand instead of using the registry, so `think` went out
 *     as a top-level field. It belongs nested at `template_vars.enable_thinking`; sent flat it is
 *     accepted, ignored, and the turn quietly runs with reasoning in whatever state it defaulted
 *     to. Engine-gated knobs went to every engine for the same reason.
 *
 * Every one of those typechecked and passed the whole suite. That is what makes them worth
 * removing rather than fixing: they are invisible to everything except a live model.
 *
 * ── THE ORDER, STATED ONCE ──
 *   built-in sampling for this kind of turn
 *     → overrides, written through the registry so each lands where the engine reads it
 *     → the caller's own transport fields, which are not tunable
 */
import type { ModelKind } from '@koala/harness-types';
import { conversationSampling, toolTurnSampling } from './sampling.js';
import { applyOverrides, type Overrides } from './tunables.js';

/**
 * Which built-in sampling profile a turn starts from.
 *
 * `tool-turn` is a dispatch turn whose only useful output is a tool call — it runs cold and
 * carries no repetition penalties, because those eliminate tool calling outright (measured 0/12
 * against 12/12). `conversation` is a turn that produces prose for a human, where the repetition
 * guard is still earning its place.
 */
export type TurnKind = 'conversation' | 'tool-turn';

export interface ModelRequestSpec {
  turn: TurnKind;
  kind?: ModelKind | undefined;
  messages: unknown;
  tools?: unknown;
  stream: boolean;
  maxTokens: number;
  reasoningEffort?: string | undefined;
  /** The served model name. Never a provider id — that selects the endpoint, not the model. */
  model?: string | undefined;
  /** The resolved chain: adopted profile, then persona, then this request. */
  overrides?: Overrides | undefined;
  /**
   * Transport fields the caller owns — `stream_options`, `tool_choice`, and the like.
   *
   * Applied last because they are not tunable and not the model's behaviour: no registry knob
   * names them, so nothing in the override chain can be trying to set them.
   */
  extra?: Record<string, unknown> | undefined;
}

export interface BuiltModelRequest {
  body: Record<string, unknown>;
  /**
   * Keys that could not be sent — unknown to the registry, or gated to another engine.
   *
   * Returned rather than swallowed so a run can record what it ASKED for beside what it sent. A
   * variant named after a configuration it was not running has already happened here twice.
   */
  unsupported: string[];
}

export function buildModelRequest(spec: ModelRequestSpec): BuiltModelRequest {
  const base: Record<string, unknown> = {
    ...(spec.turn === 'tool-turn' ? toolTurnSampling(spec.kind) : conversationSampling(spec.kind)),
    max_tokens: spec.maxTokens,
    ...(spec.reasoningEffort ? { reasoning_effort: spec.reasoningEffort } : {}),
    ...(spec.model ? { model: spec.model } : {}),
  };

  // The registry decides placement: body, nested under template_vars, or read by the loop and
  // never transmitted. Doing this by hand is what sent `think` to a field the engine ignores.
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
