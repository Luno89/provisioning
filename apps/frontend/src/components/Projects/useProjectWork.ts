import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listTrees, listBranches, listLeaves, groveKeys } from '../../api/grove'
import { listProjects, projectKeys } from '../../api/projects'
import { findLinkedProject } from '../../lib/tree-project-link'
import type { Leaf } from '../leaf-types'
import type { Branch } from '../../types/grove'
import type { LinkedProject } from './Workspace/BuildsDeploysPanel'

export interface WorkTree {
  id: string
  name: string
  goal?: string
  projectIds?: string[]
}

export function useProjectWork({ treeId, projectId }: { treeId?: string | undefined; projectId?: string | undefined }) {
  const treesRead = useQuery<WorkTree[]>({
    queryKey: groveKeys.trees(),
    queryFn: () => listTrees() as Promise<WorkTree[]>,
  })
  const branchesRead = useQuery<Branch[]>({
    queryKey: groveKeys.branches(),
    queryFn: listBranches,
    refetchInterval: 10000,
  })
  const leavesRead = useQuery<Leaf[]>({
    queryKey: ['leaves'],
    queryFn: listLeaves,
    refetchInterval: 5000,
  })
  const projectsRead = useQuery<LinkedProject[]>({
    queryKey: projectKeys.list(),
    queryFn: () => listProjects<LinkedProject>(),
    staleTime: 10_000,
  })
  const trees = useMemo(() => treesRead.data ?? [], [treesRead.data])
  const branches = useMemo(() => branchesRead.data ?? [], [branchesRead.data])
  const leaves = useMemo(() => leavesRead.data ?? [], [leavesRead.data])
  const projects = useMemo(() => projectsRead.data ?? [], [projectsRead.data])
  const reading = treesRead.isPending || branchesRead.isPending || leavesRead.isPending || projectsRead.isPending

  const tree = treeId ? trees.find((candidate) => candidate.id === treeId) : undefined
  const project = tree ? findLinkedProject(tree, projects) : projects.find((candidate) => candidate.id === projectId)
  const treeBranches = useMemo(() => (treeId ? branches.filter((branch) => branch.treeId === treeId) : []), [branches, treeId])
  const projectTrees = useMemo(
    () => (project ? trees.filter((candidate) => findLinkedProject(candidate, [project]) !== undefined) : tree ? [tree] : []),
    [trees, project, tree],
  )

  return { trees, branches, leaves, projects, tree, project, treeBranches, projectTrees, reading }
}
