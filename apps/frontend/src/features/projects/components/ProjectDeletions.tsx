import { skipToken, useMutation, useQuery } from '@tanstack/react-query'
import { deleteProject, getProjectRemoval, projectKeys } from '../api/projects'
import { errorMessage } from '../../../api/client'
import { useProjectDeletions } from '../hooks/useProjectDeletions'
import { deletionHeadline, deletionLines, latestProgress } from '../lib/project-deletion'
import { useDeletionsStore, type FollowedDeletion } from '../stores/deletions'
import type { DeletionProgress } from '../types/project-removal'

const isGone = (err: unknown) => (err as { response?: { status?: number } } | null)?.response?.status === 404

function FollowedDeletionCard({ followed }: { followed: FollowedDeletion }) {
  const forget = useDeletionsStore((state) => state.forget)
  const progress = useQuery({ queryKey: projectKeys.removal(followed.projectId), queryFn: () => getProjectRemoval(followed.projectId), staleTime: Infinity, retry: false })
  const told = useQuery<DeletionProgress>({ queryKey: projectKeys.deletion(followed.projectId), queryFn: skipToken })
  const again = useMutation({ mutationFn: () => deleteProject(followed.projectId, followed.name, followed.mode) })

  const gone = isGone(progress.error) && followed.mode === 'permanent'
  const known: DeletionProgress | undefined = gone ? { seq: Number.MAX_SAFE_INTEGER, phase: 'deleted', work: [], parts: {} } : latestProgress(told.data, progress.data?.deletion?.progress)
  const ended = known?.phase === 'archived' || known?.phase === 'deleted'
  const stuck = Boolean(known?.problem)
  const headline = deletionHeadline(known)

  return (
    <section className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] p-3 text-[12px] text-slate-300 space-y-2" aria-label={`Deleting ${followed.name}`} data-testid="project-deletion">
      <p className="text-[13px] text-slate-100"><span className="font-semibold">{followed.name}</span></p>
      <p className={stuck ? 'text-red-400' : ended ? 'text-emerald-300' : 'text-amber-300'}>{headline}</p>
      {progress.isError && !gone && <p className="text-red-400">{errorMessage(progress.error)}</p>}
      {!ended && (
        <ul className="list-disc pl-5 space-y-0.5 text-slate-400">{deletionLines(known).map((line) => <li key={line}>{line}</li>)}</ul>
      )}
      {known?.phase === 'archived' && <p className="text-slate-400">You can restore it from Deleted projects until then.</p>}
      {again.error && <p className="text-red-400">{errorMessage(again.error)}</p>}
      <div className="flex gap-2">
        {stuck && (
          <button type="button" onClick={() => again.mutate()} disabled={again.isPending} className="px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-50">Try again</button>
        )}
        {ended && (
          <button type="button" onClick={() => forget(followed.projectId)} className="px-3 py-1.5 rounded-md bg-[var(--bark-700)] hover:bg-[var(--bark-600)] cursor-pointer">Done</button>
        )}
      </div>
    </section>
  )
}

export function ProjectDeletions() {
  useProjectDeletions()
  const followed = useDeletionsStore((state) => state.followed)
  if (followed.length === 0) return null
  return (
    <div className="flex flex-col gap-2 mb-3" data-testid="project-deletions">
      {followed.map((entry) => <FollowedDeletionCard key={entry.projectId} followed={entry} />)}
    </div>
  )
}

export default ProjectDeletions
