
export interface ServiceClaim {
  ownedBy?: { treeId: string; treeName: string; projectId: string | undefined };
  adoptProjectId?: string;
}

interface TreeLike {
  id: string;
  ownerId: string;
  name: string;
  serviceName?: string | undefined;
  projectIds?: string[] | undefined;
}

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
  const already = tree.projectIds?.[0];
  const theirs = owner.projectIds?.[0];
  if (theirs && !already) claim.adoptProjectId = theirs;
  return claim;
}

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
