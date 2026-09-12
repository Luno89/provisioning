import { findLinkedProject } from '../../lib/tree-project-link.js'

export interface ProjectListTree {
  id: string
  name: string
  branchCount?: number
  projectIds?: string[]
}

export interface ProjectListProject {
  id: string
  name: string
  giteaOwner?: string
  giteaRepo?: string
  status?: string
  reason?: string
  autoDeployOnBuild?: boolean
  executionTarget?: { kind: 'k8s' } | { kind: 'local-device'; deviceId: string; path?: string }
  executionApproval?: 'plan' | 'auto'
}

export interface ProjectRow {
  id: string
  name: string
  tree?: ProjectListTree
  project?: ProjectListProject
}

export function joinProjectRows(trees: ProjectListTree[], projects: ProjectListProject[]): ProjectRow[] {
  const claimed = new Set<string>()
  const rows: ProjectRow[] = trees.map((tree) => {
    const project = findLinkedProject(tree, projects)
    if (project) claimed.add(project.id)
    return { id: tree.id, name: tree.name, tree, ...(project ? { project } : {}) }
  })
  for (const project of projects) {
    if (!claimed.has(project.id)) rows.push({ id: project.id, name: project.name, project })
  }
  return rows
}
