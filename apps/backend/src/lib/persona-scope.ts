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
import { imageForLanguage, type EgressRule, type WorkspaceSpec, type WorkspaceLanguage } from './workspace-spec.js';

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
 * Whether this persona works in the project's repository.
 *
 * Absent means NO. A repository is something a persona asks for, and most work is not a codebase —
 * a question answered, two options compared, a summary written. Defaulting to yes is what produced
 * 27 projects of which 26 never built: one per request, created because something assumed all work
 * must have somewhere to commit.
 *
 * A persona that writes files declares it, and gets a checkout, a branch and a push.
 */
export function usesRepo(persona: Pick<Persona, 'scope'> | null | undefined): boolean {
  return persona?.scope?.repo === true;
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

/**
 * The sandbox a persona runs in — the ONE place a container's shape is decided.
 *
 * ── WHY THIS FUNCTION EXISTS ──
 * Every caller used to assemble this itself. The leaf activity derived the image from the leaf's
 * language and the network from whether a checkout had happened; the Lab derived the image from the
 * experiment and passed no network at all. So the same persona got a different container depending
 * on which code path reached it, and nothing in the system could say what environment a persona
 * actually ran in.
 *
 * Everything the container is now comes off the record: its image, its limits, what it may reach on
 * the network, and anything that has to be present inside it. A caller supplies only identity —
 * which leaf, which owner — because that is the one thing a persona cannot know about itself.
 *
 * `egress` is passed through only when the persona declares it, because absent and empty mean
 * different things: absent leaves the caller's default in place, while an empty list is a deliberate
 * "open nothing".
 */
export function personaWorkspace(
  persona: Pick<Persona, 'scope'> | null | undefined,
  ids: { leafId: string; ownerId: string },
  fallback: { image?: string | undefined } = {},
): WorkspaceSpec {
  const scope = persona?.scope;
  const image = scope?.language ? imageForLanguage(scope.language as WorkspaceLanguage) : fallback.image;
  return {
    leafId: ids.leafId,
    ownerId: ids.ownerId,
    ...(image ? { image } : {}),
    ...(scope?.cpu ? { cpu: scope.cpu } : {}),
    ...(scope?.memory ? { memory: scope.memory } : {}),
    ...(scope?.egress ? { egress: scope.egress as EgressRule[] } : {}),
    ...(scope?.env?.length ? { env: scope.env } : {}),
  };
}
