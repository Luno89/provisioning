import type { SamplingConfig } from '@koala/harness-types';
import type { TurnKind } from './model-request.js';
import { tunable } from './tunables.js';

/**
 * What to send for one turn: the values the pack states for that turn kind, plus whatever it states
 * for the engine answering. Nothing is composed from a module constant, so two packs can sample
 * differently and each says so in its own record.
 */
export interface ResolvedSampling {
  body: Record<string, unknown>;
  /** Knobs the pack states that this engine cannot take. Reported, never silently sent. */
  unsupported: string[];
}

export function resolveSampling(
  sampling: SamplingConfig | undefined,
  turn: TurnKind,
  kind: string | undefined,
): ResolvedSampling {
  if (!sampling) return { body: {}, unsupported: [] };
  const all: Record<string, unknown> = {
    ...(turn === 'tool-turn' ? sampling.toolTurn : sampling.conversation),
    ...(kind ? sampling.byEngine?.[kind] ?? {} : {}),
  };

  /**
   * Each value goes where its knob says it goes. A template var is nested under `template_vars`
   * rather than sent flat, and a loop budget is dropped entirely — the harness reads that itself
   * and an engine given `maxSteps` as a sampler parameter would reject the request or ignore it.
   *
   * `applyOverrides` did this routing when these arrived as overrides. Nothing did once they became
   * pack fields, so a pack could put `think` in its sampler and have it sent flat.
   */
  const out: Record<string, unknown> = {};
  const templateVars: Record<string, unknown> = {};
  const unsupported: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    const knob = tunable(key);
    if (knob?.engine && knob.engine !== kind) {
      unsupported.push(key);
      continue;
    }
    if (knob?.placement === 'loop') continue;
    if (knob?.placement === 'template_vars') {
      templateVars[knob.field ?? knob.key] = value;
      continue;
    }
    out[key] = value;
  }
  if (Object.keys(templateVars).length) out.template_vars = templateVars;
  return { body: out, unsupported };
}

/** The body alone, for callers that only build a request. */
export const samplingFor = (
  sampling: SamplingConfig | undefined,
  turn: TurnKind,
  kind: string | undefined,
): Record<string, unknown> => resolveSampling(sampling, turn, kind).body;

