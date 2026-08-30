import type { Overrides } from './tunables.js';
import { tunable } from './tunables.js';
import type { Experiment, VariantResult } from './experiments.js';
import { summariseResults, experimentTasks, latestResults } from './experiments.js';
import { foldPromotion, type PackChange } from './derived-packs.js';
import type { PersonaPack } from '@koala/harness-types';
import type {
  HarnessProfile, ProfileVersion, PromotionProvenance, PromotionStanding,
} from '@koala/harness-types';

export type { HarnessProfile, ProfileVersion, PromotionProvenance, PromotionStanding };

export const MAX_PROFILE_HISTORY = 20;

export function supersede(
  current: HarnessProfile | null,
  next: Omit<HarnessProfile, 'history'>,
  now = new Date().toISOString(),
): HarnessProfile {
  const filed: ProfileVersion[] = current?.packId
    ? [...(current.history ?? []), {
        id: `v${Date.parse(current.updatedAt) || Date.now()}`,
        packId: current.packId,
        ...(current.from ? { from: current.from } : {}),
        supersededAt: now,
      }]
    : (current?.history ?? []);

  return {
    ...next,
    ...(filed.length ? { history: filed.slice(-MAX_PROFILE_HISTORY) } : {}),
    updatedAt: now,
  };
}

export function withPack(
  current: HarnessProfile | null,
  packId: string | undefined,
  ownerId?: string,
): Omit<HarnessProfile, 'history'> {
  return {
    ownerId: ownerId ?? current?.ownerId ?? '',
    ...(packId ? { packId } : {}),
    ...(current?.from ? { from: current.from } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function revertTo(
  current: HarnessProfile,
  versionId: string,
  now = new Date().toISOString(),
): HarnessProfile | null {
  const version = (current.history ?? []).find((v) => v.id === versionId);
  if (!version) return null;

  return supersede(current, {
    ownerId: current.ownerId,
    ...(version.packId ? { packId: version.packId } : {}),
    ...(version.from ? { from: version.from } : {}),
    updatedAt: now,
  }, now);
}

export function standingOf(experiment: Experiment, label: string): PromotionStanding | null {
  const summaries = summariseResults(latestResults(experiment));
  const mine = summaries.find((s) => s.label === label);
  if (!mine) return null;

  const rate = (s: { verified: number; attempted: number }) => (s.attempted ? s.verified / s.attempted : 0);
  const best = Math.max(...summaries.map(rate));
  const rank = summaries.filter((s) => rate(s) > rate(mine)).length + 1;

  return {
    label,
    verified: mine.verified,
    runs: mine.runs,
    attempted: mine.attempted,
    broken: mine.outcomes.broken,
    tasks: experimentTasks(experiment).length,
    rank,
    wasBest: rate(mine) >= best,
    behindBy: Math.max(0, best - rate(mine)),
    medianTokens: mine.medianTokens,
  };
}

export function buildPromotion(
  experiment: Experiment,
  label: string,
  packs: readonly PersonaPack[],
  now = new Date().toISOString(),
): { pack: PersonaPack; target: PersonaPack; standing: PromotionStanding; changes: PackChange[] } | null {
  const variant = experiment.variants.find((v) => v.label === label);
  const standing = standingOf(experiment, label);
  if (!variant || !standing) return null;

  const arm = packs.find((p) => p.id === variant.packId);
  const target = arm?.derivedFrom ? packs.find((p) => p.id === arm.derivedFrom!.packId) : undefined;
  if (!arm || !target) return null;

  const folded = foldPromotion(target, arm, now);
  if (!folded) return null;

  return { pack: folded.pack, target, standing, changes: folded.changes };
}


export function resultsForVariant(results: VariantResult[], label: string): VariantResult[] {
  return results.filter((r) => r.label === label);
}
