export interface LinkableTree {
  name: string
  projectIds?: string[] | undefined
}

export interface LinkableProject {
  id: string
  name: string
}

export function findLinkedProject<T extends LinkableProject>(
  tree: LinkableTree | undefined,
  projects: T[],
): T | undefined {
  if (!tree) return undefined
  return projects.find((p) => p.name === tree.name || tree.projectIds?.includes(p.id))
}
