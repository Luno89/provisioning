/**
 * What makes a pack storable.
 *
 * Pure, like `validatePersona` and `validateScope` beside it, so the route, a test and any future
 * writer reach the same decision. The rules here are the ones whose absence produced a live
 * failure, not a general-purpose schema:
 *
 *   - a slug, because it is the URL and the seeder's identity
 *   - a persona that EXISTS, because a pack pointing at nothing refuses at runtime
 *   - a permitted set drawn from the real effects, because the action gate fails closed on anything
 *     it does not recognise, and a typo would silently disable every tool the pack has
 */
import { ALL_EFFECTS, type ToolEffect } from './action-gate.js';
import type { PersonaPack } from '@koala/harness-types';

export const MAX_PACK_NAME = 60;

/** Same shape a URL segment can carry without escaping, which is what a slug is for. */
const SLUG = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const TOOLSETS = ['assistant', 'workbench', 'none'];

export interface PackCandidate {
  slug?: unknown;
  name?: unknown;
  personaId?: unknown;
  toolset?: unknown;
  tools?: unknown;
  permitted?: unknown;
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
  // The slug is the URL (`#/chat/koala`) and what seeding matches on, so two packs sharing one is a
  // route that cannot resolve and a seed that never re-adds.
  if (existing.some((p) => p.id !== id && p.slug === slug)) {
    return `You already have a pack with the slug "${slug}".`;
  }

  /**
   * The persona must exist, and must be one of yours.
   *
   * `personas` is already ownership-filtered by the caller, so an id that is not in it is either
   * missing or someone else's — a conflation `ClusterService.getById` makes deliberately, for the
   * same reason: distinguishing them tells an attacker which ids are real.
   *
   * Checked here rather than at run time because the run-time answer is a refusal in the middle of
   * a conversation, which is a bad place to learn that a pack was saved pointing at nothing.
   */
  const personaId = typeof candidate.personaId === 'string' ? candidate.personaId : '';
  if (!personaId) return 'A pack needs a persona.';
  if (!personas.some((p) => p.id === personaId)) {
    return 'That persona does not exist. Pick one from your personas.';
  }

  if (!TOOLSETS.includes(String(candidate.toolset))) {
    return `Toolset must be one of ${TOOLSETS.join(', ')}.`;
  }

  if (candidate.tools !== undefined) {
    if (!Array.isArray(candidate.tools) || candidate.tools.some((t) => typeof t !== 'string')) {
      return 'Tools must be a list of tool names.';
    }
  }

  if (candidate.permitted !== undefined) {
    if (!Array.isArray(candidate.permitted)) return 'Permitted must be a list of effects.';
    const bad = candidate.permitted.find((e) => !(ALL_EFFECTS as readonly string[]).includes(String(e)));
    if (bad !== undefined) {
      // The gate refuses anything it does not recognise, so an unchecked typo here would not read
      // as a bad value — it would read as every tool in the pack quietly failing.
      return `"${String(bad)}" is not an effect. Use ${ALL_EFFECTS.join(', ')}.`;
    }
  }

  return undefined;
}

/** Narrowed for callers that have validated already. */
export const asEffects = (v: unknown): ToolEffect[] =>
  Array.isArray(v) ? (v.filter((e) => (ALL_EFFECTS as readonly string[]).includes(String(e))) as ToolEffect[]) : [];
