/**
 * Promoting a winning configuration into the harness's own defaults.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM JUST SAVING SETTINGS ──
 * A profile is not a preferences blob. It is a claim that some configuration is BETTER, and every
 * such claim came from a specific experiment on a specific suite. So the evidence travels with the
 * values: which experiment, which variant, how many tasks it won, and whether it actually came
 * first. Without that, a default is an unexplained number six months later — precisely the thing
 * `harness-config.ts` exists to prevent for the built-in settings, and there is no reason promoted
 * ones deserve less.
 *
 * ── WHY PROMOTING A LOSER IS ALLOWED ──
 * The obvious rule is "only the winner may be promoted", and it is wrong. A variant that ties on
 * verification while using half the tokens is a legitimate thing to adopt, and so is one that loses
 * narrowly on a suite you have decided is unrepresentative. What must never happen is adopting a
 * loser WITHOUT NOTICING — so this computes the standing and hands it back, and the caller has to
 * show it. Refusing would push the same decision into a hand-edited config file where no evidence
 * is recorded at all.
 *
 * Pure, so the reasoning can be tested without a model.
 */
import type { Overrides } from './tunables.js';
import { tunable } from './tunables.js';
import type { Experiment, VariantResult } from './experiments.js';
import { summariseResults, experimentTasks, latestResults } from './experiments.js';
import type {
  HarnessProfile, OverrideChange, ProfileVersion, PromotionProvenance, PromotionStanding,
} from '@koala/harness-types';

/** Re-exported: the promotion UI renders these verbatim. */
export type { HarnessProfile, OverrideChange, ProfileVersion, PromotionProvenance, PromotionStanding };

/**
 * How many superseded configurations to keep.
 *
 * Bounded because this rides on a record read on every run. Deep enough to undo a bad afternoon,
 * shallow enough that it never becomes the reason a profile read is slow.
 */
export const MAX_PROFILE_HISTORY = 20;

/**
 * Files the configuration currently in force into history, and returns the profile with `next`
 * adopted.
 *
 * Adopting a default used to be unrecoverable: the previous values were overwritten, so there was
 * no diff, no record of what changed, and no way back. Every path that changes a profile — promote,
 * reset, revert — goes through here, so none of them can be the one that forgets.
 */
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
    // Oldest dropped first: the useful undo is always the recent one.
    ...(filed.length ? { history: filed.slice(-MAX_PROFILE_HISTORY) } : {}),
    updatedAt: now,
  };
}

/**
 * A profile with different overrides and everything else intact.
 *
 * ── WHY THIS IS NOT THREE LINES IN THE ROUTE ──
 * It was, and the three lines were wrong. `PUT /api/harness/profile` rebuilt the record from
 * `ownerId`, `overrides` and `updatedAt`, then tried to carry the rest forward by spreading
 * `current.reason` and `current.promotedFrom` — two fields that do not exist on this type. Both
 * spreads were permanent no-ops, so every override edit silently dropped `personaId` and `from`.
 *
 * `personaId` is there because promotion once copied `overrides` and nothing else, handing Koala a
 * winning arm's sampling knobs while discarding the prompt that actually won. Losing it on the next
 * unrelated edit is the same defect with a longer fuse. `from` is what lets the Lab say which
 * experiment produced the configuration in force; without it a promoted default is
 * indistinguishable from a hand-typed one.
 *
 * So the carry-forward lives beside `supersede`, whose header already states the rule this file
 * exists to enforce: every path that changes a profile goes through here, so none of them can be
 * the one that forgets. A caller cannot get it wrong by writing out fewer fields than the type has.
 */
export function withOverrides(
  current: HarnessProfile | null,
  overrides: HarnessProfile['overrides'],
  ownerId?: string,
): Omit<HarnessProfile, 'history'> {
  return {
    ownerId: ownerId ?? current?.ownerId ?? '',
    overrides,
    // Conditional, not defaulted: absent and present are different states, and an empty provenance
    // would make a profile that was never promoted claim an origin it does not have.
    ...(current?.personaId ? { personaId: current.personaId } : {}),
    ...(current?.from ? { from: current.from } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Restores a superseded configuration, filing the current one as it goes.
 *
 * Reverting is itself a change worth recording — otherwise undoing twice would silently lose the
 * state in between, which is the failure mode of every undo that is not append-only.
 */
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

/**
 * Where a variant actually stands in its own experiment.
 *
 * Computed rather than trusted from the UI: the button that promotes must not be the thing that
 * decides whether promoting is a good idea.
 */
export function standingOf(experiment: Experiment, label: string): PromotionStanding | null {
  // The most recent execution — promoting on a stale run would adopt a configuration that
  // the latest evidence may already have contradicted.
  const summaries = summariseResults(latestResults(experiment));
  const mine = summaries.find((s) => s.label === label);
  if (!mine) return null;

  /**
   * Over ATTEMPTED, not over every run.
   *
   * This function already said it ranks by rate "because variants can differ in run count when one
   * errored" — and then divided by the total, so a variant the harness killed ranked below one that
   * genuinely lost. Promotion decides what every later run inherits, so it is the worst place for a
   * denominator that counts an outage against an arm.
   */
  const rate = (s: { verified: number; attempted: number }) => (s.attempted ? s.verified / s.attempted : 0);
  const best = Math.max(...summaries.map(rate));
  // Rank by verified RATE, not count: variants can differ in run count when one errored.
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

/**
 * The overrides a variant represents, as a complete configuration.
 *
 * A variant's own overrides are only the axis it varied; everything else it ran at was whatever the
 * profile in force supplied. Promoting the axis alone would produce a profile that never existed as
 * a running configuration — so the base is folded in and the result is the thing that was actually
 * measured.
 */
export function promotedOverrides(base: Overrides, variantOverrides: Overrides): Overrides {
  const merged: Overrides = { ...base };
  for (const [key, value] of Object.entries(variantOverrides)) {
    // `language` picks a container image rather than a call parameter, so it is not part of a
    // harness profile even though a variant may carry it.
    if (value === undefined || key === 'language') continue;
    merged[key] = value;
  }
  return merged;
}


/**
 * What promoting would actually change.
 *
 * Shown before it is applied. "Promote" on a variant labelled `think=true` sounds like it changes
 * one thing, and after a few promotions onto a profile it rarely does.
 */
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

/**
 * Builds the profile a promotion would produce.
 *
 * Returns the standing alongside it rather than deciding on it, because whether a non-winning
 * variant is worth adopting is a judgement about the suite, which this cannot see.
 */
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
      /**
       * Carried, because it is often the thing that won.
       *
       * A variant is a named override bag AND optionally a persona, and promotion used to take only
       * the bag. Cleared rather than inherited when the winning arm had no persona: keeping the
       * previous one would attribute a win to a prompt that had nothing to do with it.
       */
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

/**
 * The overrides a run should start from.
 *
 * Beneath the caller's own, so an experiment can still vary a knob the profile pinned — otherwise
 * promoting a value would make it untestable, and the harness would slowly accumulate settings
 * nobody could challenge.
 *
 * ── null MEANS "IGNORE THE PROFILE FOR THIS KEY" ──
 * Layering alone cannot express a control arm. A variant labelled `shipped-prompt` carrying no
 * overrides inherits whatever the profile pinned, so once a prompt is promoted that variant
 * silently stops testing the shipped prompt while still being named after it — measured the hard
 * way, on an experiment whose control turned out to be running the promoted prompt and whose three
 * arms were therefore two.
 *
 * Passing `null` strips the key entirely, so the run falls back to the harness's built-in default.
 * It is the only way to say "as it ships" once anything has been adopted.
 */
export const RESET_TO_DEFAULT = null;

export function effectiveOverrides(profile: HarnessProfile | null, own: Overrides = {}): Overrides {
  const merged: Overrides = { ...(profile?.overrides ?? {}), ...own };
  for (const [key, value] of Object.entries(own)) {
    if (value === RESET_TO_DEFAULT) delete merged[key];
  }
  return merged;
}

/** Keys whose value came from the profile rather than from the variant, for the run record. */
export function keysFromProfile(profile: HarnessProfile | null, own: Overrides = {}): string[] {
  return Object.keys(profile?.overrides ?? {})
    .filter((key) => !(key in own))
    .sort();
}

/** Results for one variant, for a caller that wants to show the evidence beside the button. */
export function resultsForVariant(results: VariantResult[], label: string): VariantResult[] {
  return results.filter((r) => r.label === label);
}
