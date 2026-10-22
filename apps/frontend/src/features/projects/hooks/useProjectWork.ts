import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { groveKeys } from '../api/grove'
import { projectKeys } from '../api/projects'
import { keyedBy, useWorkSource } from '../lib/work-source'
import { findLinkedProject } from '../lib/tree-project-link'
import type { Leaf } from '../lib/leaf-types'
import type { Branch } from '../types/grove'
import type { LinkedProject } from '../components/Workspace/BuildsDeploysPanel'

export interface WorkTree {
  id: string
  name: string
  goal?: string
  projectIds?: string[]
}

export function useProjectWork({ treeId, projectId }: { treeId?: string | undefined; projectId?: string | undefined }) {
  const source = useWorkSource()
  const every = source.pushed ? undefined : 3_000
  const treesRead = useQuery<WorkTree[]>({
    queryKey: keyedBy(source, groveKeys.trees()),
    queryFn: source.listTrees,
    ...(every ? { refetchInterval: every } : {}),
  })
  const branchesRead = useQuery<Branch[]>({
    queryKey: keyedBy(source, groveKeys.branches()),
    queryFn: source.listBranches,
    refetchInterval: every ?? 10000,
  })
  const leavesRead = useQuery<Leaf[]>({
    queryKey: keyedBy(source, ['leaves']),
    queryFn: source.listLeaves,
    refetchInterval: every ?? 5000,
  })
  const projectsRead = useQuery<LinkedProject[]>({
    queryKey: keyedBy(source, projectKeys.list()),
    queryFn: source.listProjects,
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
