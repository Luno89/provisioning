import { useQuery } from '@tanstack/react-query'
import { CircleDot, Loader2 } from 'lucide-react'
import { listReleases, releaseKeys } from '../../../api/releases'
import { getTreeRun, groveKeys, listBranches, listLeaves } from '../../../api/grove'
import type { Leaf } from '../../leaf-types'
import type { Branch } from '../../../types/grove'
import { projectStatus } from '../Board/board'
import { useTreeCards } from '../Workspace/useTreeCards'
import { workingOn } from './shared'

function Live({ projectId }: { projectId: string }) {
  const releases = useQuery({ queryKey: releaseKeys.list(projectId), queryFn: () => listReleases(projectId), refetchInterval: 30_000 })
  if (releases.isPending) return null
  const status = projectStatus(releases.data?.releases ?? [], [])
  return status.live
    ? <span className="flex items-center gap-1 text-slate-300"><CircleDot size={11} className="text-emerald-400" aria-hidden="true" /> Live {status.live.commit.slice(0, 8)}</span>
    : <span className="flex items-center gap-1 text-slate-500"><CircleDot size={11} aria-hidden="true" /> Nothing live yet</span>
}

function Work({ treeId, previewWaiting }: { treeId: string; previewWaiting: boolean }) {
  const { data: status } = useQuery({ queryKey: groveKeys.run(treeId), queryFn: () => getTreeRun(treeId), refetchInterval: 15_000 })
  const branches = useQuery<Branch[]>({ queryKey: groveKeys.branches(), queryFn: listBranches })
  const leaves = useQuery<Leaf[]>({ queryKey: groveKeys.leaves(), queryFn: listLeaves })
  const cards = useTreeCards(treeId)
  const own = new Set((branches.data ?? []).filter((branch) => branch.treeId === treeId).map((branch) => branch.id))
  const mine = (leaves.data ?? []).filter((leaf) => own.has(leaf.branchId))
  const working = workingOn(mine)
  const ready = mine.filter((leaf) => leaf.status === 'pending').length
  const asks = status?.state === 'running' ? status.asking?.length ?? 0 : 0
  const waiting = cards.count + asks + (previewWaiting ? 1 : 0)
  return (
    <>
      {status?.state === 'running'
        ? <span className="flex items-center gap-1 text-emerald-300"><Loader2 size={11} className="animate-spin" aria-hidden="true" /> {working.length ? `Working on “${working[0]}”${working.length > 1 ? ` and ${working.length - 1} more` : ''}` : 'Working'}</span>
        : ready > 0 ? <span className="text-slate-400">{ready} {ready === 1 ? 'story' : 'stories'} ready</span> : null}
      {waiting > 0 && <span className="text-amber-300" data-testid="pulse-waiting">{waiting} waiting on you</span>}
    </>
  )
}

function PreviewOnly({ projectId }: { projectId: string }) {
  const releases = useQuery({ queryKey: releaseKeys.list(projectId), queryFn: () => listReleases(projectId), refetchInterval: 30_000 })
  return projectStatus(releases.data?.releases ?? [], []).preview ? <span className="text-amber-300" data-testid="pulse-waiting">1 waiting on you</span> : null
}

function WithPreview({ projectId, treeId }: { projectId: string; treeId: string }) {
  const releases = useQuery({ queryKey: releaseKeys.list(projectId), queryFn: () => listReleases(projectId), refetchInterval: 30_000 })
  return <Work treeId={treeId} previewWaiting={Boolean(projectStatus(releases.data?.releases ?? [], []).preview)} />
}

export function ProjectPulse({ treeId, projectId }: { treeId?: string | undefined; projectId?: string | undefined }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] mt-1" data-testid="project-pulse">
      {projectId && <Live projectId={projectId} />}
      {treeId && projectId && <WithPreview projectId={projectId} treeId={treeId} />}
      {treeId && !projectId && <Work treeId={treeId} previewWaiting={false} />}
      {!treeId && projectId && <PreviewOnly projectId={projectId} />}
    </span>
  )
}

export default ProjectPulse
