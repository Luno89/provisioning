import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitBranch, Plus, Loader2 } from 'lucide-react'
import { listTrees, groveKeys } from '../../api/grove.js'
import { listProjects, projectKeys } from '../../api/projects.js'
import { listLocalAgentDevices, localAgentKeys, type LocalAgentDevice } from '../../api/local-agents.js'
import { joinProjectRows, type ProjectListTree, type ProjectListProject } from './shared.js'
import { ProjectCard } from './ProjectCard.js'

export function ProjectList({ onOpenTree, onOpenProject, onNewTree, onNewProject }: {
  onOpenTree: (treeId: string) => void
  onOpenProject: (projectId: string) => void
  onNewTree: () => void
  onNewProject: () => void
}) {
  const { data: trees = [], isLoading: treesLoading } = useQuery<ProjectListTree[]>({
    queryKey: groveKeys.trees(),
    queryFn: () => listTrees() as Promise<ProjectListTree[]>,
  })
  const { data: projects = [], isLoading: projectsLoading } = useQuery<ProjectListProject[]>({
    queryKey: projectKeys.list(),
    queryFn: () => listProjects<ProjectListProject>(),
    refetchInterval: 5000,
  })
  const { data: localAgents = [] } = useQuery<LocalAgentDevice[]>({
    queryKey: localAgentKeys.list(),
    queryFn: listLocalAgentDevices,
  })

  const rows = useMemo(() => joinProjectRows(trees, projects), [trees, projects])
  const isLoading = treesLoading || projectsLoading

  return (
    <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[var(--bark-800)]/60">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2.5">
            <GitBranch size={20} className="text-blue-400" />
            Projects
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Everything Koala is working on, and every repository it builds and deploys.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onNewTree}
            className="bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white px-3.5 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-all"
          >
            <Plus size={15} /> New Tree
          </button>
          <button
            onClick={onNewProject}
            className="bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-all"
          >
            <Plus size={15} /> New Project
          </button>
        </div>
      </header>

      {isLoading ? (
        <div className="text-slate-400 text-xs flex items-center gap-2 py-8">
          <Loader2 className="animate-spin text-blue-400" size={16} /> Loading projects…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-[var(--bark-800)] bg-[var(--bark-900)]/40 p-10 text-center max-w-xl mx-auto">
          <GitBranch className="mx-auto mb-3 text-slate-500" size={32} />
          <h3 className="text-sm font-semibold text-slate-200 mb-1">No projects yet</h3>
          <p className="text-slate-400 text-xs mb-4">
            Start a new tree to work with Koala, or register a repository to build and deploy it.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <ProjectCard
              key={row.id}
              row={row}
              localAgents={localAgents}
              onOpen={() => (row.tree ? onOpenTree(row.tree.id) : onOpenProject(row.project!.id))}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default ProjectList
