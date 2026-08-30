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

/**
 * The sampler for a caller that names no pack — a plain chat turn, a probe, the suite author. It is
 * the shipped `koala` row, so it is a record the user can edit, not a constant this module keeps.
 * Undefined only when nothing is seeded, in which case the engine's own defaults apply.
 */
export async function defaultSampling(
  store: { getPersonaPacks(): Promise<{ slug: string; ownerId?: string | undefined; sampling?: SamplingConfig }[]> },
): Promise<SamplingConfig | undefined> {
  const rows = await store.getPersonaPacks();
  return rows.find((p) => p.slug === 'koala' && p.ownerId === undefined)?.sampling;
}
