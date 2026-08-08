/**
 * Making sure a leaf has somewhere durable to put its work.
 *
 * ── WHY THIS IS NOT OPTIONAL ──
 * A leaf's sandbox is a pod that is destroyed when the leaf finishes. Without a repository, the
 * work goes with it — and the leaf still reports success, because the agent really did write the
 * file it says it wrote. Verified live: a leaf created `/work/index.js`, correct and complete, and
 * the file was read out of the pod seconds before the pod was destroyed. Nothing else ever saw it.
 *
 * `projectId` was the way to avoid that and it was opt-in, so the default path was the losing one.
 * A request that never picked a project now gets one made for it.
 *
 * ── ONE REPOSITORY PER REQUEST, NOT PER LEAF ──
 * The branch (the conversation) is the unit, because that is the unit a plan is decomposed within:
 * leaf 2 building on leaf 1 means reading leaf 1's commits, and cross-repository is not a
 * hand-off, it is a dependency. One repo with a branch per leaf also leaves something a person can
 * open and diff, which is what "the agent built something" should mean.
 */
import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';
import type { ProjectMetadata } from './types.js';

/** Gitea repository names allow a narrow set; a title never reaches this unfiltered. */
export function autoRepoNameFor(branchId: string): string {
  return `koala-request-${branchId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

export interface LeafProjectDeps {
  db: Pick<Database, 'getProjects' | 'saveProject'>;
  /** Creates the user's Gitea account if needed and returns its name. */
  ensureAccount: (ownerId: string) => Promise<{ username: string }>;
  /** Whether the repository is already there. Checked first so provisioning is idempotent. */
  repoExists: (username: string, name: string) => Promise<boolean>;
  /** Creates the repository. Must be initialised — an empty repo cannot be cloned onto a branch. */
  createRepo: (username: string, name: string) => Promise<void>;
  newId: () => string;
}

/**
 * The project a leaf should work in: the one it was given, or one made for its request.
 *
 * Returns the project WITHOUT persisting it onto the leaf — the activity owns the leaf record and
 * writes it back once, at the end, together with everything else it learned.
 */
export async function resolveLeafProject(deps: LeafProjectDeps, leaf: Leaf): Promise<ProjectMetadata> {
  const projects = await deps.db.getProjects();

  if (leaf.projectId) {
    const chosen = projects.find((p) => p.id === leaf.projectId && p.ownerId === leaf.ownerId);
    // Ownership-scoped, then falls through rather than throwing: a projectId that does not resolve
    // is a stale reference, and losing the work over it is a worse outcome than working somewhere.
    if (chosen) return chosen;
  }

  const repo = autoRepoNameFor(leaf.branchId);
  const existing = projects.find((p) => p.ownerId === leaf.ownerId && p.giteaRepo === repo);
  // The second leaf of a request must land in the FIRST leaf's repository, or the hand-off is
  // between two unrelated repos and nothing is shared.
  if (existing) return existing;

  const account = await deps.ensureAccount(leaf.ownerId);

  /**
   * Idempotent, because the leaves of one request run CONCURRENTLY when nothing orders them.
   *
   * Observed live: two leaves of the same request both found no project, both tried to create the
   * repository, and the loser got `duplicate key value violates unique constraint` — a 500 that
   * left it with no repository at all, which is the exact failure this module exists to prevent.
   * The same 500 also appears when a previous run created the repository but did not get as far as
   * writing the project row.
   */
  if (!(await deps.repoExists(account.username, repo))) {
    try {
      await deps.createRepo(account.username, repo);
    } catch (err) {
      // Lost a race, or the repo appeared between the check and the create. Either way the end
      // state we wanted now exists; anything else surfaces on the clone with a clear message.
      if (!(await deps.repoExists(account.username, repo))) throw err;
    }
  }

  // Re-read: the racing leaf may have written the project row while we were creating the repo, and
  // two rows for one repository would split the request's leaves across two project ids.
  const raced = (await deps.db.getProjects())
    .find((p) => p.ownerId === leaf.ownerId && p.giteaRepo === repo);
  if (raced) return raced;

  const project: ProjectMetadata = {
    id: deps.newId(),
    name: repo,
    ownerId: leaf.ownerId,
    giteaOwner: account.username,
    giteaRepo: repo,
    appType: 'generic',
    createdAt: new Date().toISOString(),
  };
  await deps.db.saveProject(project);
  return project;
}
