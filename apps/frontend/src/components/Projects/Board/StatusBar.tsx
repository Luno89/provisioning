import { useQuery } from '@tanstack/react-query'
import { CircleDot, Hammer, Loader2 } from 'lucide-react'
import { listReleases, releaseKeys } from '../../../api/releases'
import { listProjectRuns } from '../../../api/projects'
import { ago } from '../../home-summary'
import type { PipelineRun } from '../../PipelineRunRow'
import { OpenApp } from '../Workspace/OpenApp'
import { SignInReveal } from '../Workspace/SignInReveal'
import { Decision } from '../Workspace/ReleasesPanel'
import { projectStatus } from './board'
import Reading from '../Reading'

const BUILD_TONE: Record<PipelineRun['status'], string> = {
  queued: 'text-sky-300',
  running: 'text-sky-300',
  succeeded: 'text-emerald-300',
  failed: 'text-rose-300',
}

export function StatusBar({ projectId }: { projectId: string }) {
  const releases = useQuery({ queryKey: releaseKeys.list(projectId), queryFn: () => listReleases(projectId), refetchInterval: 10_000 })
  const runs = useQuery<PipelineRun[]>({
    queryKey: ['project-runs', projectId],
    queryFn: () => listProjectRuns<PipelineRun>(projectId),
    refetchInterval: (query) => ((query.state.data ?? []).some((run) => run.status === 'queued' || run.status === 'running') ? 3000 : 15_000),
  })
  const status = projectStatus(releases.data?.releases ?? [], runs.data ?? [])
  const build = status.lastBuild

  if (releases.isPending || runs.isPending) return <Reading label="Reading what is live and the last build…" />

  return (
    <div className="space-y-2" data-testid="project-status">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
        {status.live ? (
          <span className="flex items-center gap-1.5 text-slate-300">
            <CircleDot size={13} className="text-emerald-400" aria-hidden="true" />
            Live: <span className="font-mono text-slate-100">{status.live.commit.slice(0, 8)}</span>
            {status.live.slot && <span className="text-slate-500">slot {status.live.slot}</span>}
            {status.live.since && <span className="text-slate-500">{ago(status.live.since)}</span>}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-slate-500"><CircleDot size={13} aria-hidden="true" /> Nothing live yet</span>
        )}
        {status.live && <OpenApp projectId={projectId} />}
        {status.live && <SignInReveal projectId={projectId} />}
        {status.preparing && (
          <span className="flex items-center gap-1.5 text-sky-300">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Releasing <span className="font-mono">{status.preparing.commit.slice(0, 8)}</span>
          </span>
        )}
        {build && (
          <span className="flex items-center gap-1.5 text-slate-400" title={build.error ?? build.held ?? build.skipped}>
            <Hammer size={12} aria-hidden="true" /> Last build <span className={BUILD_TONE[build.status]}>{build.status}</span>
            <span className="font-mono">{build.commit.slice(0, 8)}</span> {ago(build.at)}
            {build.held && <span className="text-amber-300">· waits for the client&apos;s database</span>}
            {build.skipped && <span className="text-slate-500">· not released</span>}
          </span>
        )}
      </div>
      {status.preview && (
        <Decision projectId={projectId} release={status.preview} preview={releases.data?.addresses.preview} />
      )}
    </div>
  )
}

export default StatusBar
