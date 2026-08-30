import type { SamplingConfig } from '@koala/harness-types';
import type { TurnKind } from './model-request.js';

/**
 * What to send for one turn: the values the pack states for that turn kind, plus whatever it states
 * for the engine answering. Nothing is composed from a module constant, so two packs can sample
 * differently and each says so in its own record.
 */
export function samplingFor(
  sampling: SamplingConfig | undefined,
  turn: TurnKind,
  kind: string | undefined,
): Record<string, unknown> {
  if (!sampling) return {};
  return {
    ...(turn === 'tool-turn' ? sampling.toolTurn : sampling.conversation),
    ...(kind ? sampling.byEngine?.[kind] ?? {} : {}),
  };
}

