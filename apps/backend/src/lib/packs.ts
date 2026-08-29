import type { PersonaPack } from '@koala/harness-types';

export const MAX_PACK_NAME = 60;

const SLUG = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export interface PackCandidate {
  slug?: unknown;
  name?: unknown;
  personaId?: unknown;
  tools?: unknown;
}

export function validatePack(
  candidate: PackCandidate,
  existing: Pick<PersonaPack, 'id' | 'slug'>[],
  personas: { id: string }[],
  id?: string,
): string | undefined {
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (!name) return 'A pack needs a name.';
  if (name.length > MAX_PACK_NAME) return `Name must be ${MAX_PACK_NAME} characters or fewer.`;

  const slug = typeof candidate.slug === 'string' ? candidate.slug.trim() : '';
  if (!slug) return 'A pack needs a slug.';
  if (!SLUG.test(slug)) {
    return `"${slug}" is not a valid slug — lower-case letters, numbers and hyphens only.`;
  }
  if (existing.some((p) => p.id !== id && p.slug === slug)) {
    return `You already have a pack with the slug "${slug}".`;
  }

  const personaId = typeof candidate.personaId === 'string' ? candidate.personaId : '';
  if (!personaId) return 'A pack needs a persona.';
  if (!personas.some((p) => p.id === personaId)) {
    return 'That persona does not exist. Pick one from your personas.';
  }

  if (candidate.tools !== undefined) {
    if (!Array.isArray(candidate.tools) || candidate.tools.some((t) => typeof t !== 'string')) {
      return 'Tools must be a list of tool names.';
    }
  }

  return undefined;
}

export function packForLeaf(
  packs: readonly PersonaPack[],
  leaf: { packId?: string | undefined; personaId?: string | undefined },
  fallbackPersonaId?: string | undefined,
): PersonaPack | undefined {
  if (leaf.packId) {
    const named = packs.find((p) => p.id === leaf.packId || p.slug === leaf.packId);
    if (named) return named;
  }
  const personaId = leaf.personaId ?? fallbackPersonaId;
  if (!personaId) return undefined;
  return packs.find((p) => p.personaId === personaId);
}

