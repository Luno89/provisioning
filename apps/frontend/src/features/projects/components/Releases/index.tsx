import Reading from '../Reading'
import { useProjectWork } from '../../hooks/useProjectWork'
import { useRouteSync } from '../../hooks/useRouteSync'
import { BuildsDeploysPanel } from '../Workspace/BuildsDeploysPanel'

export default function ProjectReleases({ treeId, projectId }: { treeId?: string | undefined; projectId?: string | undefined }) {
  const { project, reading } = useProjectWork({ treeId, projectId })
  useRouteSync(treeId ? { kind: 'tree', treeId, page: 'releases' } : projectId ? { kind: 'project', projectId, page: 'releases' } : undefined)

  if (reading) return <Reading label="Reading its builds and releases…" className="px-3 py-6" />
  if (!project) {
    return <p className="px-3 py-6 text-[12px] text-slate-400" data-testid="no-releases">This work builds no app, so nothing of it is released.</p>
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="project-releases">
      <div className="max-w-4xl mx-auto rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] p-3 text-[12px]">
        <BuildsDeploysPanel project={project} />
      </div>
    </div>
  )
}
