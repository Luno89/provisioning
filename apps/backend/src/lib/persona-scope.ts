/**
 * Reading a persona's environment, and inheriting it.
 *
 * ── WHAT THIS NO LONGER DOES ──
 * It used to decide whether a persona was ALLOWED on a piece of work, by matching a category on the
 * persona against a category on the leaf. That category was a classification invented to sit beside
 * the record rather than in it: the same environment ended up described twice, once by the persona's
 * own fields and once by a label, with nothing keeping the two honest.
 *
 * A persona now simply describes itself — the tools it uses, the network it may reach, the workspace
 * it works in, where it writes, how long it gets. Nothing here restricts what work it may be asked
 * to do, because nothing here knows better than the planner what a persona is good for.
 */
import type { Persona } from '@koala/harness-types';

/**
 * The tools a run should actually offer.
 *
 * The INTERSECTION of what the persona declares and what the environment has. A persona naming a
 * tool the sandbox cannot provide does not conjure it; a persona naming a subset is held to that
 * subset, which is the point — it is how a persona that must not search is stopped from searching
 * by construction rather than by its own good behaviour.
 *
 * A persona with no declared tools gets everything available, which is what every persona did
 * before the toolset moved onto the record.
 */
export function allowedTools(persona: Pick<Persona, 'scope'> | null | undefined, available: string[]): string[] {
  const declared = persona?.scope?.tools;
  if (!declared?.length) return available;
  return available.filter((t) => declared.includes(t));
}

/**
 * Whether this persona's sandbox gets the project's repository.
 *
 * Absent means yes. Every leaf had a checkout before personas owned their environment, and a
 * persona written then must not silently lose one — losing a repository means losing the work,
 * since the sandbox is destroyed when the leaf ends.
 */
export function usesRepo(persona: Pick<Persona, 'scope'> | null | undefined): boolean {
  return persona?.scope?.repo !== false;
}

/**
 * A persona with everything it inherits already folded in.
 *
 * ── WHY INHERITANCE ──
 * Testing a variation should not mean copying a persona. A copy drifts from its original the first
 * time either is edited, and the Lab's whole job is comparing two things that differ in one place.
 * "Researcher, but forty steps" is a record with a parent and one changed field.
 *
 * The child wins field by field, not wholesale: a variant that changes `run.maxSteps` keeps its
 * parent's prompt, tools and network rather than silently losing them — the same full-replace
 * hazard this codebase has now hit in five other shapes.
 *
 * Defensive by construction. A missing parent resolves to the child alone and a cycle stops at the
 * first repeat, because a filing mistake must never be able to stop work from running.
 */
export function flattenPersona<T extends Pick<Persona, 'id' | 'basedOn' | 'systemPrompt' | 'overrides' | 'scope'>>(
  persona: T,
  all: T[],
): T {
  const chain: T[] = [];
  const seen = new Set<string>();
  let node: T | undefined = persona;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.push(node);
    node = node.basedOn ? all.find((p) => p.id === node!.basedOn) : undefined;
  }

  // Root first, so each descendant overwrites what it inherited.
  return chain.reduceRight((base, layer) => ({
    ...base,
    ...layer,
    ...(layer.systemPrompt ?? base.systemPrompt ? { systemPrompt: layer.systemPrompt ?? base.systemPrompt } : {}),
    overrides: { ...base.overrides, ...layer.overrides },
    ...(base.scope || layer.scope
      ? {
          scope: {
            ...base.scope,
            ...layer.scope,
            // `run` merges too. A variant changing the step budget must not drop the pacing and
            // withdrawal that made its parent work.
            ...(base.scope?.run || layer.scope?.run
              ? { run: { ...base.scope?.run, ...layer.scope?.run } }
              : {}),
          },
        }
      : {}),
  }), chain[chain.length - 1]!);
}
