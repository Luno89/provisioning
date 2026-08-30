import type { PersonaPack } from '@koala/harness-types';
import { tunable, TUNABLES } from './tunables.js';

/**
 * A partial pack: what one experiment arm changes about the pack it is based on. Deep-merged, so an
 * arm that raises a temperature does not have to restate the whole sampler.
 */
export type PackEdit = {
  [K in keyof PersonaPack]?: PersonaPack[K] extends object | undefined
    ? Partial<PersonaPack[K]> | PersonaPack[K]
    : PersonaPack[K];
};

export interface PackChange {
  path: string;
  from: unknown;
  to: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMerge<T>(base: T, edit: unknown): T {
  if (!isPlainObject(edit)) return (edit === undefined ? base : edit) as T;
  if (!isPlainObject(base)) return structuredClone(edit) as T;

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(edit)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

/** Every leaf value that differs, as a dotted path. Arrays compare whole. */
export function diffPacks(before: unknown, after: unknown, at = ''): PackChange[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffPacks(before[k], after[k], at ? `${at}.${k}` : k));
  }
  return JSON.stringify(before) === JSON.stringify(after)
    ? []
    : [{ path: at, from: before, to: after }];
}

/**
 * One pack, with a partial edit merged in field by field. The editor sends what changed; everything
 * it did not name keeps the value the pack already has.
 */
export function mergeValues(pack: PersonaPack, edit: PackEdit): Partial<PersonaPack> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(edit)) {
    if (value === undefined) continue;
    out[key] = deepMerge((pack as unknown as Record<string, unknown>)[key], value);
  }
  return out as Partial<PersonaPack>;
}

export const derivedPackId = (experimentId: string, label: string): string =>
  `exp:${experimentId}:${label}`;

export const isDerived = (pack: Pick<PersonaPack, 'derivedFrom'>): boolean =>
  pack.derivedFrom !== undefined;

/**
 * The packs a user should be shown. Arm packs are scoped to their experiment and would otherwise
 * fill the list with near-duplicates of whatever they were derived from.
 */
export const visibleToUser = <T extends Pick<PersonaPack, 'derivedFrom'>>(packs: readonly T[]): T[] =>
  packs.filter((p) => !isDerived(p));

/**
 * The pack one arm runs as: its base, with the arm's edit applied. The id is derived from the
 * experiment and label rather than generated, so re-editing an arm updates its pack instead of
 * leaving the previous one behind attached to finished runs.
 */
export function deriveVariantPack(
  base: PersonaPack,
  experimentId: string,
  label: string,
  edit: PackEdit,
  now: string,
): PersonaPack {
  const merged = deepMerge(structuredClone(base), edit);
  return {
    ...merged,
    id: derivedPackId(experimentId, label),
    slug: `${base.slug}-${label}`,
    name: `${base.name} (${label})`,
    derivedFrom: { packId: base.id, experimentId, label },
    createdAt: base.createdAt,
    updatedAt: now,
  };
}

/**
 * Promotion: the arm's values overwrite the pack it came from, keeping that pack's identity. The
 * caller is expected to show `changes` and ask before saving — this returns what would happen, it
 * does not decide that it should.
 */
export function foldPromotion(
  target: PersonaPack,
  arm: PersonaPack,
  now: string,
): { pack: PersonaPack; changes: PackChange[] } | null {
  if (arm.derivedFrom?.packId !== target.id) return null;

  const { derivedFrom: _derived, id: _id, slug: _slug, name: _name, createdAt: _created, updatedAt: _updated, ...values } = arm;
  const pack: PersonaPack = {
    ...target,
    ...values,
    id: target.id,
    slug: target.slug,
    name: target.name,
    createdAt: target.createdAt,
    updatedAt: now,
  };
  delete (pack as { derivedFrom?: unknown }).derivedFrom;

  return { pack, changes: diffPacks(withoutIdentity(target), withoutIdentity(pack)) };
}

const withoutIdentity = (pack: PersonaPack) => {
  const { id: _id, slug: _slug, name: _name, ownerId: _owner, createdAt: _c, updatedAt: _u, derivedFrom: _d, ...rest } = pack;
  return rest;
};

/**
 * A knob grid — `{ temperature: 0.9 }` — as a pack edit. Each tunable declares the pack field it
 * sets, so the Lab's axis picker and the pack editor write pack values rather than a bag of
 * overrides applied on top of one. A knob that declares no field is descriptive and sets nothing.
 */
export function editFromKnobs(knobs: Record<string, unknown>): PackEdit {
  const edit: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(knobs)) {
    const path = tunable(key)?.path;
    if (!path || value === undefined) continue;

    const parts = path.split('.');
    let at = edit;
    for (const part of parts.slice(0, -1)) {
      at[part] ??= {};
      at = at[part] as Record<string, unknown>;
    }
    at[parts[parts.length - 1]!] = value;
  }
  return edit as PackEdit;
}

/**
 * The arms of one experiment: a variant naming a pack, plus the pack itself. Every caller that used
 * to write `{ label, overrides }` writes this instead, and saves the packs alongside the experiment.
 */
export function deriveArms(
  base: PersonaPack,
  experimentId: string,
  arms: readonly { label: string; knobs?: Record<string, unknown>; edit?: PackEdit }[],
  now: string,
): { variants: { label: string; packId: string }[]; packs: PersonaPack[] } {
  const packs = arms.map((arm) =>
    deriveVariantPack(base, experimentId, arm.label, arm.edit ?? editFromKnobs(arm.knobs ?? {}), now));
  return {
    variants: packs.map((p, i) => ({ label: arms[i]!.label, packId: p.id })),
    packs,
  };
}

const atPath = (pack: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((at, key) => (isPlainObject(at) ? at[key] : undefined), pack);

/**
 * What a pack may not be set to. Every knob declares the pack field it sets and the range it is
 * valid in, so this reads the pack through that table.
 *
 * Values the table has never heard of pass: a pack's sampler legitimately carries engine-specific
 * parameters, and refusing those would make a pack unable to describe its own engine.
 */
export function validatePackValues(pack: PersonaPack): string | null {
  for (const knob of TUNABLES) {
    if (!knob.path) continue;
    const value = atPath(pack, knob.path);
    if (value === undefined || value === null) continue;

    if (knob.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) return `${knob.label} must be a number.`;
      if (knob.min !== undefined && value < knob.min) return `${knob.label} must be at least ${knob.min}.`;
      if (knob.max !== undefined && value > knob.max) return `${knob.label} must be at most ${knob.max}.`;
    }
    if (knob.type === 'boolean' && typeof value !== 'boolean') return `${knob.label} must be true or false.`;
    if (knob.choices?.length && !knob.choices.some((c) => c.value === value)) {
      return `${knob.label} must be one of ${knob.choices.map((c) => c.value).join(', ')}.`;
    }
  }
  return null;
}
