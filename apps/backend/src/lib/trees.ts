/**
 * A tree: the project a run of conversations belongs to.
 *
 * ── WHAT THIS IS FOR ──
 * A branch is one request. A tree is the thing the requests are FOR — an API, a paper, a dataset —
 * and it owns what should outlive any single conversation: the repository, what has been learned,
 * and what "done" means for the whole effort.
 *
 * Without it, everything hung off the branch. `resolveLeafProject` created a repository per branch,
 * so a second conversation about the same work started in a different repository from the first;
 * measured on this instance, 27 projects existed and 26 had never produced a build. Memory was
 * project-scoped, so it was branch-scoped in practice and nothing carried over.
 *
 * ── SCOPE OF THIS FILE ──
 * Types and pure helpers only. The tree does not yet own the repository or the memory scope — that
 * is the next step, and doing it in the same change as introducing the record would mean a
 * migration and a new concept landing together.
 */
import type { WorkspaceLanguage } from './workspace-spec.js';

/**
 * What a tree is producing.
 *
 * A registry rather than a boolean or a set of `if (type === 'x')` predicates scattered around.
 * This codebase already learned that with cluster providers: adding one used to mean twenty greps,
 * until the predicates were collected into a single table. A tree type decides the workspace, the
 * deliverable and what verification even means, so it will attract exactly the same sprawl.
 */
/**
 * A project type, by id.
 *
 * A bare string now, not a union: types are owned records (lib/tree-types.ts), so the set is not
 * known at compile time — which is the point. Validity is 'does this owner have one with this id',
 * answered by `resolveTreeType` against the store.
 */
export type TreeType = string;


export interface Tree {
  id: string;
  ownerId: string;
  name: string;
  type: TreeType;
  /** What this tree is for, in the user's own words. Seeds the discovery questions later. */
  goal?: string;
  /**
   * The repositories this tree owns, primary first.
   *
   * A list rather than one id: an effort can legitimately span an API and its client. Primary-first
   * ordering is what lets a leaf that does not name a repository still land somewhere sensible.
   *
   * Empty until the next step moves repository ownership here — declared now so that change is a
   * migration of behaviour rather than of shape.
   */
  projectIds?: string[];
  /**
   * What a service this tree produces is CALLED, when other agents call it.
   *
   * Distinct from `name`, and shorter. The name is a heading — "Weather API MCP" — and it becomes
   * the prefix on every tool the service exposes, where a long one makes the tools hard to tell
   * apart at a glance. Optional: the tree name is a perfectly good fallback and is used when this
   * is absent or when the planner answered with a sentence instead of a name.
   *
   * It exists at all because the alternative was worse: with nothing here every tool was prefixed
   * with the request id the deployment happens to carry.
   */
  serviceName?: string;
  createdAt: string;
  updatedAt: string;
}

/** The repository a leaf should work in when it has not named one. */
export function primaryProjectId(tree: Pick<Tree, 'projectIds'>): string | undefined {
  return tree.projectIds?.[0];
}

const MAX_NAME = 120;
const MAX_GOAL = 2000;

/**
 * A new tree from untrusted input.
 *
 * Mirrors normaliseLeafInput: one place that decides what a caller may set, so the HTTP route and
 * any future tool cannot drift apart the way the two leaf-creation paths did three times.
 */
export function normaliseTreeInput(raw: Record<string, unknown>): { name: string; type: TreeType; goal?: string } | undefined {
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '';
  if (!name) return undefined;
  /**
   * Shape only. Whether the type EXISTS is a question for the store, not for this module — types are
   * owned records now, so a compile-time union cannot answer it and a hardcoded list here would be
   * the very duplication this change removes. The route resolves it and refuses an unknown id.
   */
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  if (!type) return undefined;
  const goal = typeof raw.goal === 'string' ? raw.goal.trim().slice(0, MAX_GOAL) : '';
  return { name, type, ...(goal ? { goal } : {}) };
}


/**
 * Records that a tree's work produced a repository.
 *
 * `projectIds` was declared when trees were introduced and never written to, so a tree could
 * accumulate branches whose repositories it did not know about — which made `primaryProjectId`
 * always undefined and every branch of one effort create its own repo.
 *
 * Appends rather than replaces, primary-first ordering preserved: the first repository a tree
 * produces is the one later branches join.
 */
export function withProject(tree: Tree, projectId: string, now = new Date().toISOString()): Tree {
  if (tree.projectIds?.includes(projectId)) return tree;
  // Spread, because saveTree is a full replace — naming the fields here is how a rename silently
  // dropped projectIds before.
  return { ...tree, projectIds: [...(tree.projectIds ?? []), projectId], updatedAt: now };
}
