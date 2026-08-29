import type { Overrides } from './tunables.js';
import { tunable } from './tunables.js';
import type { Experiment, VariantResult } from './experiments.js';
import { summariseResults, experimentTasks, latestResults } from './experiments.js';
import type {
  HarnessProfile, OverrideChange, ProfileVersion, PromotionProvenance, PromotionStanding,
} from '@koala/harness-types';

export type { HarnessProfile, OverrideChange, ProfileVersion, PromotionProvenance, PromotionStanding };

export const MAX_PROFILE_HISTORY = 20;

export function supersede(
  current: HarnessProfile | null,
  next: Omit<HarnessProfile, 'history'>,
  now = new Date().toISOString(),
): HarnessProfile {
  const filed: ProfileVersion[] = current && Object.keys(current.overrides ?? {}).length
    ? [...(current.history ?? []), {
        id: `v${Date.parse(current.updatedAt) || Date.now()}`,
        overrides: current.overrides,
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

export function withOverrides(
  current: HarnessProfile | null,
  overrides: HarnessProfile['overrides'],
  ownerId?: string,
): Omit<HarnessProfile, 'history'> {
  return {
    ownerId: ownerId ?? current?.ownerId ?? '',
    overrides,
    ...(current?.personaId ? { personaId: current.personaId } : {}),
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
    overrides: version.overrides,
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

export function promotedOverrides(base: Overrides, variantOverrides: Overrides): Overrides {
  const merged: Overrides = { ...base };
  for (const [key, value] of Object.entries(variantOverrides)) {
    if (value === undefined || key === 'language') continue;
    merged[key] = value;
  }
  return merged;
}

export function diffOverrides(current: Overrides, next: Overrides): OverrideChange[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  const changes: OverrideChange[] = [];

  for (const key of [...keys].sort()) {
    const from = current[key];
    const to = next[key];
    if (from === to) continue;
    changes.push({ key, label: tunable(key)?.label ?? key, from, to });
  }
  return changes;
}

export function buildPromotion(
  experiment: Experiment,
  label: string,
  current: HarnessProfile | null,
  ownerId: string,
  now = new Date().toISOString(),
): { profile: HarnessProfile; standing: PromotionStanding; changes: OverrideChange[] } | null {
  const variant = experiment.variants.find((v) => v.label === label);
  const standing = standingOf(experiment, label);
  if (!variant || !standing) return null;

  const base = current?.overrides ?? {};
  const overrides = promotedOverrides(base, variant.overrides);

  return {
    profile: {
      ownerId,
      overrides,
      ...(variant.personaId ? { personaId: variant.personaId } : {}),
      from: {
        experimentId: experiment.id,
        experimentName: experiment.name,
        variantLabel: label,
        verified: standing.verified,
        runs: standing.runs,
        tasks: standing.tasks,
        wasBest: standing.wasBest,
        promotedAt: now,
      },
      updatedAt: now,
    },
    standing,
    changes: diffOverrides(base, overrides),
  };
}

export const RESET_TO_DEFAULT = null;

export function effectiveOverrides(profile: HarnessProfile | null, own: Overrides = {}): Overrides {
  const merged: Overrides = { ...(profile?.overrides ?? {}), ...own };
  for (const [key, value] of Object.entries(own)) {
    if (value === RESET_TO_DEFAULT) delete merged[key];
  }
  return merged;
}

export function keysFromProfile(profile: HarnessProfile | null, own: Overrides = {}): string[] {
  return Object.keys(profile?.overrides ?? {})
    .filter((key) => !(key in own))
    .sort();
}

export function resultsForVariant(results: VariantResult[], label: string): VariantResult[] {
  return results.filter((r) => r.label === label);
}
