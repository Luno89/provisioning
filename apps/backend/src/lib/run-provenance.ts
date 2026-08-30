import type { BudgetConfig, PersonaPack, SamplingConfig } from '@koala/harness-types';

export interface RanAs {
  packId: string;
  slug: string;
  packUpdatedAt: string;
  sampling: SamplingConfig;
  budget: BudgetConfig;
}

/**
 * What a run was configured by, copied into the run record at the moment it starts.
 *
 * A pack id alone would be a lie the first time somebody edits the pack: the run would claim a
 * configuration it never had. The prompt config is not copied because its whole effect — the
 * composed system prompt — is already recorded verbatim beside this.
 */
export function ranAs(
  pack: Pick<PersonaPack, 'id' | 'slug' | 'updatedAt' | 'sampling' | 'budget'> | null | undefined,
): RanAs | undefined {
  if (!pack) return undefined;
  return {
    packId: pack.id,
    slug: pack.slug,
    packUpdatedAt: pack.updatedAt,
    sampling: structuredClone(pack.sampling),
    budget: structuredClone(pack.budget),
  };
}
