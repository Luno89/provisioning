/**
 * Deciding whether a persona belongs on a piece of work.
 *
 * ── WHAT THIS IS FOR ──
 * Every picker in the product offered every persona for every job. The cost of that is measured:
 * the "Framer" persona, whose job is splitting one big question into several and which must never
 * search, was attached to a research leaf — which grants web tools automatically — and spent its
 * whole budget searching instead of splitting. Nothing in the system knew the pairing was wrong.
 *
 * ── FILTERED, NOT REFUSED ──
 * A mismatch is reported, not blocked. Scope is authored by a person guessing where their prompt
 * will be useful, and a guess that turns into a hard refusal makes a legitimate combination
 * impossible to try. Hiding it from the picker prevents the accident; allowing an explicit
 * assignment keeps the escape hatch. The reason travels with the run so a bad pairing is visible
 * afterwards rather than only suspected.
 */
import type { Persona } from '@koala/harness-types';

/** What a piece of work is, in the terms a persona's scope is written in. */
export interface WorkContext {
  context: 'planning' | 'code' | 'research';
  language?: string | undefined;
  /** The tools this work can actually offer. Absent when filtering a picker, before any sandbox exists. */
  available?: string[];
  /** The model this work will run on. */
  model?: string | undefined;
}

export interface ScopeVerdict {
  fits: boolean;
  /**
   * Why not, in one sentence, or an advisory when it fits with a caveat.
   *
   * Written for the person who has to act on it, so it names the persona and the job rather than
   * reporting a failed predicate.
   */
  reason?: string;
}

export function personaFits(persona: Pick<Persona, 'name' | 'scope'>, work: WorkContext): ScopeVerdict {
  const scope = persona.scope;
  // No scope means the persona predates this, or is genuinely general. Either way it fits, and
  // treating an absent declaration as a mismatch would retire every persona already in use.
  if (!scope) return { fits: true };

  if (scope.contexts?.length && !scope.contexts.includes(work.context)) {
    return {
      fits: false,
      reason: `"${persona.name}" is for ${scope.contexts.join(' or ')} work, and this is ${work.context}.`,
    };
  }

  if (scope.languages?.length && work.language && !scope.languages.includes(work.language)) {
    return {
      fits: false,
      reason: `"${persona.name}" expects ${scope.languages.join(' or ')}, and this runs in ${work.language}.`,
    };
  }

  /**
   * A persona that names tools the work cannot offer does not fit.
   *
   * Checked only when the work knows what it has: `available` is absent while filtering a picker,
   * before any sandbox exists, and refusing there would hide the persona from the only screen where
   * it can be chosen.
   */
  if (scope.tools?.length && work.available) {
    const missing = scope.tools.filter((t) => !work.available!.includes(t));
    if (missing.length) {
      return {
        fits: false,
        reason: `"${persona.name}" needs ${missing.join(', ')}, which this work does not provide.`,
      };
    }
  }

  // Advisory, never a refusal: prompts transfer between models imperfectly, and blocking would
  // discard working configurations to prevent a problem that may not exist.
  if (scope.tunedFor && work.model && scope.tunedFor !== work.model) {
    return {
      fits: true,
      reason: `"${persona.name}" was tuned on ${scope.tunedFor}, and this runs on ${work.model}.`,
    };
  }

  return { fits: true };
}

/** The personas worth offering for a piece of work. */
export function personasFor<T extends Pick<Persona, 'name' | 'scope'>>(personas: T[], work: WorkContext): T[] {
  return personas.filter((p) => personaFits(p, work).fits);
}

/**
 * The tools a run should actually offer.
 *
 * The INTERSECTION of what the persona declares and what the environment has. A persona naming a
 * tool the sandbox cannot provide does not conjure it; a persona naming a subset is held to that
 * subset, which is the whole point — it is how a persona that must not search is prevented from
 * searching by something else's default rather than by its own good behaviour.
 *
 * A persona with no declared tools gets everything available, which is what every persona written
 * before this did.
 */
export function allowedTools(persona: Pick<Persona, 'scope'> | null | undefined, available: string[]): string[] {
  const declared = persona?.scope?.tools;
  if (!declared?.length) return available;
  return available.filter((t) => declared.includes(t));
}

/**
 * The persona a piece of work will actually run as.
 *
 * ── WHY THERE IS ALWAYS ONE ──
 * Work is handed to someone. A leaf with no persona used to mean a bare sandbox configured by
 * whatever the calling activity hardcoded — which is exactly the coupling the persona record exists
 * to remove, so "none" cannot be the answer.
 *
 * The order is specific-to-general, and each step is a weaker claim than the one before: the leaf
 * named someone; the owner adopted someone from the Lab; the context has a default. Only the last
 * is a guess, and it is a saved one.
 */
export function resolvePersona<T extends Pick<Persona, 'id' | 'name' | 'scope'>>(
  personas: T[],
  work: WorkContext,
  named?: string | undefined,
  adopted?: string | undefined,
): T | undefined {
  const byId = (id?: string) => (id ? personas.find((p) => p.id === id) : undefined);
  return (
    byId(named)
    ?? byId(adopted)
    // Sorted by name so two personas claiming the same context behave the same way every run. That
    // is an authoring mistake, and a deterministic wrong answer is far easier to notice than a
    // wrong answer that moves.
    ?? [...personas]
      .sort((a, b) => a.name.localeCompare(b.name))
      .find((p) => p.scope?.defaultFor?.includes(work.context))
  );
}
