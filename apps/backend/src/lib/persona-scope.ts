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
import { GITEA_EGRESS } from './leaf-checkout.js';
import type { Persona } from '@koala/harness-types';
import {
  imageForLanguage, capableImage, egressForBindings, packageAccess,
  type EgressRule, type WorkspaceSpec, type WorkspaceLanguage, type WorkspaceBinding,
} from './workspace-spec.js';

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
 * Whether this persona has an environment to work in at all.
 *
 * ── WHY A CAPABILITY AND NOT A NAME ──
 * This was `isChatOnly(persona)`, which compared the name to the literal string "Koala". That is
 * wrong in both directions: rename Koala and it becomes assignable to leaves it cannot run, and
 * every future chat persona is assignable from the day it is written. The name was never the
 * reason — the reason is stated in `acceptLeaf`: a persona carries the whole sandbox, and one with
 * no toolchain, no tools and no repository would run in an environment nobody chose.
 *
 * So the check reads the absence directly. A persona that declares any part of an environment can
 * run a leaf; one that declares none of it cannot, whatever it is called. Note `Reviewer` and
 * `Judge` declare `tools: []` deliberately and still qualify, because they set `language` — an
 * empty toolset is a decision about tools, not an absence of environment.
 */
/**
 * The persona a leaf actually runs as, with its pack's decisions applied over it.
 *
 * ── WHY A MERGE AND NOT A SECOND PARAMETER EVERYWHERE ──
 * `personaWorkspace`, `agentRunOptions`, `allowedTools`, `usesRepo` and `wantsMcp` all read the
 * persona's scope, in five places across three files. Threading a pack through each is five chances
 * to thread it through four of them — which is the shape of every bug in this area so far: the chat
 * route consulted a tool grant the prompt builder did not, and the two disagreed silently.
 *
 * So the pack is folded in ONCE, here, and everything downstream keeps reading one record. An
 * absent pack returns the persona untouched, which is what every leaf predating packs does.
 *
 * Only `tools` is overridden today, because that is the grant a pack owns outright. Sampling and
 * budgets travel through `resolveConfig`'s pack layer instead, where their provenance is recorded.
 */
export function withPack<T extends Pick<Persona, 'scope'>>(
  persona: T | null,
  pack: { tools?: string[] } | null | undefined,
): T | null {
  if (!persona || !pack?.tools?.length) return persona;
  return { ...persona, scope: { ...(persona.scope ?? {}), tools: [...pack.tools] } };
}

export function canRunLeaf(persona: Pick<Persona, 'scope'> | null | undefined): boolean {
  const scope = persona?.scope;
  if (!scope) return false;
  return Boolean(scope.tools?.length || scope.language || scope.repo || scope.egress?.length);
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
  /**
   * What the WORK needs, as opposed to what the agent needs.
   *
   * A project's toolchain wins over the persona's own, because a Go repository needs Go whichever
   * persona is standing in it. The persona's `language` is what it runs in when there is no project
   * at all — a Researcher writing prose does not need a compiler, and should not inherit one from
   * whatever it happens to be working alongside.
   */
  work: {
    language?: string | undefined;
    /**
     * The services this project declared a need for, already resolved and ownership-checked.
     *
     * Two things come off these and both are derived rather than declared: the files projected at
     * `$SERVICE_BINDING_ROOT`, and the egress that makes them reachable. Writing either by hand
     * would create a second list that has to agree with the first, and the one that silently wins
     * is the network policy.
     */
    bindings?: readonly { port: number; source: { namespace: string } }[] | undefined;
    files?: WorkspaceBinding[] | undefined;
    /**
     * Tools the WORKSPACE needs regardless of what the work is written in — `git` when this leaf
     * takes a checkout.
     *
     * Kept separate from `language` on purpose. A research paper's language is `base`, because prose
     * needs no toolchain; that a clone also needs git is a fact about checkouts. Folding the second
     * into the first is how the tree-type seeds briefly claimed a research paper was a Node project.
     */
    requires?: readonly string[] | undefined;
    /**
     * Whether this leaf is cloning. Decides the forge egress, for the reason given on
     * `GITEA_EGRESS` — it is what cloning is, not what any particular role is allowed.
     */
    checkout?: boolean | undefined;
  } = {},
): WorkspaceSpec {
  const scope = persona?.scope;

  const language = work.language ?? scope?.language;
  // Satisfied from the image catalogue, which declares what each image is `absent` — see
  // `capableImage`. Reads the data rather than naming a case.
  const image = language || work.requires?.length
    ? capableImage(language, work.requires ?? [])
    : undefined;

  /**
   * The persona's own rules first, then the project's dependencies.
   *
   * Additive on purpose. A persona's `egress` says what that ROLE may always reach — the Merger
   * needs Gitea whatever it is merging — while a binding says what THIS work needs. Neither can
   * remove the other, and a persona that opens nothing still gets what its project declared.
   */
  /**
   * A leaf that clones needs to reach Gitea.
   *
   * ── WHY THIS IS INJECTED, WHEN AN EARLIER VERSION DELIBERATELY STOPPED INJECTING IT ──
   * `ExecuteLeafActivity` records removing exactly this: "A persona that works in a repository
   * declares the egress its clone needs… The last version of this injected that rule when a
   * checkout existed, which meant the same persona had a different network depending on which
   * caller reached it."
   *
   * That objection was about the CALLER deciding. It no longer does: whether a leaf takes a
   * checkout is derived from the persona's own toolset (`writesFiles`), so a persona that writes
   * files always clones and therefore always has the same network — which is the property that
   * comment was protecting. What it cannot survive is a persona declaring `egress: []` because it
   * had no repository, and then being given one: measured, the clone reached Gitea's address and
   * failed to connect.
   *
   * Corrected here rather than on the persona records because `ensurePersonas` only ever ADDS, so
   * editing the seeds would fix new installs and leave every existing persona broken.
   */
  /**
   * What this LANGUAGE needs in order to install anything — see `packageAccess`.
   *
   * Derived rather than declared, for the same reason as the checkout rule above: it was written by
   * hand on one persona out of eleven, so a Builder could `npm install` and every other role in the
   * same repository could not.
   *
   * Conditional on an image having been chosen, which keeps ONE rule: whoever picks the toolchain
   * picks its registry. A spec that names no image leaves that to the caller's default, and quietly
   * opening egress for a toolchain we did not choose would be a hole with nothing behind it.
   */
  const packages = image ? packageAccess(language) : { env: [], egress: [] };

  const egress = dedupeEgress([
    ...((scope?.egress ?? []) as EgressRule[]),
    ...egressForBindings(work.bindings ?? []),
    ...(work.checkout ? [{ ...GITEA_EGRESS, ports: [...GITEA_EGRESS.ports] }] : []),
    ...packages.egress,
  ]);

  /**
   * Persona first, and first wins: a team pointing one role at an internal mirror is a real thing,
   * and two entries with one name is not something Kubernetes merges — which of them applies would
   * depend on ordering nobody controls.
   */
  const env = [...(scope?.env ?? []), ...packages.env]
    .filter((e, i, all) => all.findIndex((o) => o.name === e.name) === i);

  return {
    leafId: ids.leafId,
    ownerId: ids.ownerId,
    ...(image ? { image } : {}),
    ...(scope?.cpu ? { cpu: scope.cpu } : {}),
    ...(scope?.memory ? { memory: scope.memory } : {}),
    // Still only when something asked for it: absent and empty mean different things, and an empty
    // list is a deliberate "open nothing" that must not be turned into "leave the default".
    ...(egress.length || scope?.egress ? { egress } : {}),
    ...(env.length ? { env } : {}),
    ...(work.files?.length ? { bindings: work.files } : {}),
  };
}

/**
 * Merges rules that name the same namespace, because two entries for one namespace is not what a
 * NetworkPolicy means — the ports union, and a duplicate reads as a second hole in a review.
 */
function dedupeEgress(rules: EgressRule[]): EgressRule[] {
  const out: EgressRule[] = [];
  for (const rule of rules) {
    const existing = rule.namespace
      ? out.find((r) => r.namespace === rule.namespace)
      : undefined;
    if (!existing) { out.push({ ...rule, ...(rule.ports ? { ports: [...rule.ports] } : {}) }); continue; }
    existing.ports = [...new Set([...(existing.ports ?? []), ...(rule.ports ?? [])])];
  }
  return out;
}
