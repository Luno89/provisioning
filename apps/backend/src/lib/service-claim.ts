/**
 * Two conversations about one service landing in one repository.
 *
 * ── WHAT HAPPENED THREE TIMES ──
 * A second run was asked for the same GitHub MCP server. The planner did everything right: it
 * called `list_mcp_servers`, found `github-mcp` already running with three tools, said "No need to
 * rebuild it", and proposed only a leaf to verify it — naming the very project the server is built
 * from.
 *
 * The leaf then built in a NEW repository anyway. `resolveLeafProject` reads the leaf's project,
 * then the TREE's, then falls back to one per branch — and the new tree had no project, because
 * knowing a project id in prose is not the same as attaching it. The model would have had to call
 * `set_leaf_project` per leaf, and it did not.
 *
 * The result was a second deployment answering to `github-mcp`, a second Terraform state, and a
 * second set of tools under the same prefix. That collision then had to be worked around in the
 * chat grant, in the persona picker, and in the registry listing — three display rules papering
 * over one identity bug, which is what made it worth fixing here instead.
 *
 * ── THE SIGNAL ──
 * `serviceName` is a claim of identity: it is what a service's tools are prefixed with and what a
 * persona names to reach it. Two trees declaring the same one are not two services, they are two
 * conversations about one. So the second declaration ADOPTS the first's repository rather than
 * quietly starting a rival.
 *
 * Deliberately not a refusal. "That name is taken" would be correct and useless — the user asked
 * for work on that service, and making them rename it would produce `github-mcp-2`, which is the
 * collision with extra steps.
 */

export interface ServiceClaim {
  /** The tree the name already belongs to, when it belongs to one. */
  ownedBy?: { treeId: string; treeName: string; projectId: string | undefined };
  /** What this tree should do: take the existing repository, or keep its own path. */
  adoptProjectId?: string;
}

interface TreeLike {
  id: string;
  ownerId: string;
  name: string;
  serviceName?: string | undefined;
  projectIds?: string[] | undefined;
}

/**
 * Whether a service name is already claimed, and what to do about it.
 *
 * `trees` is every tree; ownership is filtered here rather than by the caller so a claim can never
 * be resolved against another tenant's service — the name is per user, and two users naming their
 * service `github-mcp` have nothing to do with each other.
 *
 * A tree that already holds a project keeps it: adopting into a tree with its own repository would
 * repoint work that is already landing somewhere, which is the failure this exists to prevent, in
 * the other direction.
 */
export function claimService(
  name: string,
  tree: TreeLike,
  trees: readonly TreeLike[],
): ServiceClaim {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return {};

  const owner = trees.find((t) =>
    t.id !== tree.id
    && t.ownerId === tree.ownerId
    && (t.serviceName ?? '').trim().toLowerCase() === wanted);
  if (!owner) return {};

  const claim: ServiceClaim = {
    ownedBy: { treeId: owner.id, treeName: owner.name, projectId: owner.projectIds?.[0] },
  };
  // Only when there is something to adopt AND nothing to lose.
  const already = tree.projectIds?.[0];
  const theirs = owner.projectIds?.[0];
  if (theirs && !already) claim.adoptProjectId = theirs;
  return claim;
}

/** What the branch is told, so the adoption is not a silent repoint. */
export function claimNotice(name: string, claim: ServiceClaim): string {
  if (!claim.ownedBy) return '';
  const where = claim.ownedBy.treeName;
  return claim.adoptProjectId
    ? `"${name}" already belongs to **${where}**, so this work will go into that service's existing `
      + 'repository rather than starting a second one. Changes here rebuild and redeploy the '
      + 'service that is already running.'
    : `"${name}" is also the service name of **${where}**. Two services sharing a name share the `
      + 'prefix on every tool they expose, so an agent granted one may reach either. Rename one of '
      + 'them unless they are meant to be the same service.';
}
