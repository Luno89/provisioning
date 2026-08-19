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
export type TreeType =
  | 'mcp-server'
  | 'research-paper'
  | 'api-service'
  | 'library'
  | 'dataset'
  | 'investigation'
  | 'migration'
  | 'benchmark'
  | 'data-analysis'
  | 'decision-brief'
  | 'docs-site'
  | 'infra-module';

export interface TreeTypeSpec {
  id: TreeType;
  label: string;
  /** One line, shown when picking a type. Says what the tree produces, not how it works. */
  summary: string;
  /**
   * The language the DELIVERABLE is written in, which decides the workspace image.
   *
   * The type decides, full stop — that is what makes it an opinionated template rather than a
   * label. A persona can still install whatever it needs on top: the image is where work STARTS,
   * not a limit on the worker. Those are different things, and conflating them is how I nearly
   * proposed making a research project repo-less.
   */
  language: WorkspaceLanguage;
  /**
   * What this kind of project produces.
   *
   * `service` deploys and must answer; `artefact` produces files that are reviewed and never
   * deployed. Deliberately NOT the `usesRepo` boolean this replaces — every project gets a
   * repository, because opt-in lost work and `leaf-project.ts` exists to say so.
   */
  produces: 'service' | 'artefact';
  /** What finishing looks like, in the user's words. Shown on the tree, and seeds its acceptance. */
  doneMeans: string;
}

export const TREE_TYPES: TreeTypeSpec[] = [
  {
    /**
     * Added because the data asked for it: four of the five trees on this instance are MCP servers
     * labelled `api-service` or `infra-module`, because there was nothing closer. A type people
     * reach for by approximation is a type that should exist.
     */
    id: 'mcp-server',
    label: 'MCP server',
    summary: 'A service exposing tools over MCP, callable by this platform and by other agents.',
    language: 'node',
    produces: 'service',
    doneMeans: 'It builds, it deploys, it answers `initialize`, and its tools return real data when called.',
  },
  {
    id: 'research-paper',
    language: 'base',
    produces: 'artefact',
    label: 'Research paper',
    summary: 'A written answer with sources — a comparison, a survey, a recommendation.',
    doneMeans: 'Every question is answered, every claim carries a source, and the write-up reads as one piece.',
  },
  {
    id: 'api-service',
    language: 'node',
    produces: 'service',
    label: 'API / service',
    summary: 'Something that runs and answers requests.',
    doneMeans: 'Its tests pass, it builds, it deploys, and the endpoint responds.',
  },
  {
    id: 'library',
    language: 'node',
    produces: 'artefact',
    label: 'Library / CLI',
    summary: 'Code other things import or run. No deployment.',
    doneMeans: 'Its tests pass and it installs cleanly from a fresh checkout.',
  },
  {
    id: 'dataset',
    language: 'python',
    produces: 'artefact',
    label: 'Dataset',
    summary: 'Data collected, cleaned and labelled, with provenance.',
    doneMeans: 'The schema validates, the row counts are what was promised, and every row can say where it came from.',
  },
  {
    id: 'investigation',
    language: 'node',
    produces: 'artefact',
    label: 'Investigation',
    summary: 'Why something is broken or slow, and what to do about it.',
    doneMeans: 'There is a reproduction that fails before the fix and passes after it.',
  },
  {
    id: 'migration',
    language: 'node',
    produces: 'artefact',
    label: 'Migration / refactor',
    summary: 'A bounded change across code that already exists.',
    doneMeans: 'The existing test suite still passes and behaviour is unchanged.',
  },
  {
    id: 'benchmark',
    language: 'python',
    produces: 'artefact',
    label: 'Benchmark',
    summary: 'A task set, run across variants, compared.',
    doneMeans: 'Every run completed, the metrics are produced, and the spread between runs is reported.',
  },
  {
    id: 'data-analysis',
    language: 'python',
    produces: 'artefact',
    label: 'Data analysis',
    summary: 'Load, analyse, and report — charts and conclusions.',
    doneMeans: 'The analysis runs end to end from a clean checkout and produces its outputs.',
  },
  {
    id: 'decision-brief',
    language: 'base',
    produces: 'artefact',
    label: 'Decision brief',
    summary: 'Options compared against criteria, ending in a recommendation.',
    doneMeans: 'Every option is covered against every criterion, and every claim is cited.',
  },
  {
    id: 'docs-site',
    language: 'node',
    produces: 'service',
    label: 'Documentation',
    summary: 'Documentation derived from a codebase.',
    doneMeans: 'Links resolve and the code examples actually run.',
  },
  {
    id: 'infra-module',
    language: 'node',
    produces: 'artefact',
    label: 'Infrastructure module',
    summary: 'A reusable piece of infrastructure.',
    doneMeans: 'It provisions, verifies, and destroys again without leaving anything behind.',
  },
];

const BY_ID = new Map(TREE_TYPES.map((t) => [t.id, t]));

/** Validated rather than trusted: the type arrives as untrusted JSON and the union checks nothing at runtime. */
export function isTreeType(value: unknown): value is TreeType {
  return typeof value === 'string' && BY_ID.has(value as TreeType);
}

export function treeTypeSpec(type: TreeType): TreeTypeSpec {
  // Non-null: every member of the union is in the table, and the test below keeps it that way.
  return BY_ID.get(type)!;
}

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
  if (!isTreeType(raw.type)) return undefined;
  const goal = typeof raw.goal === 'string' ? raw.goal.trim().slice(0, MAX_GOAL) : '';
  return { name, type: raw.type, ...(goal ? { goal } : {}) };
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
