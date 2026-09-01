import type { BudgetConfig, PersonaPack, SamplingConfig } from '@koala/harness-types';
import type { EndpointSource } from './model-registry.js';

export interface RanAs {
  packId: string;
  slug: string;
  packUpdatedAt: string;
  sampling: SamplingConfig;
  budget: BudgetConfig;
  endpoint?: { id: string; source: EndpointSource };
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
  endpoint?: { id: string; source: EndpointSource } | undefined,
): RanAs | undefined {
  if (!pack) return undefined;
  return {
    packId: pack.id,
    slug: pack.slug,
    packUpdatedAt: pack.updatedAt,
    sampling: structuredClone(pack.sampling),
    budget: structuredClone(pack.budget),
    ...(endpoint ? { endpoint: { ...endpoint } } : {}),
  };
}
