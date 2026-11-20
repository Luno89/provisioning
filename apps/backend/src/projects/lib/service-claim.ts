
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
