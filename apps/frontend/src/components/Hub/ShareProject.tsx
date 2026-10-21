import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Users } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { hubElsewhere, hubKeys } from '../../api/hub'
import { useShareProject, useSharedProjects } from './shared'

export default function ShareProject({ project }: { project: { id: string; name: string } }) {
  const navigate = useNavigate()
  const elsewhere = useQuery({ queryKey: [...hubKeys.all, 'elsewhere'], queryFn: hubElsewhere, staleTime: Infinity })
  const here = !elsewhere.isPending && !elsewhere.data
  const mine = useSharedProjects()
  const share = useShareProject()
  const shared = here ? mine.data?.find((entry) => entry.project.origin?.projectId === project.id) : undefined

  if (elsewhere.isPending) return null
  if (!here) {
    const next = `/shared-new?name=${encodeURIComponent(project.name)}&project=${encodeURIComponent(project.id)}`
    return (
      <div className="space-y-1.5 p-3 text-[12px]" data-testid="share-project">
        <p className="text-slate-300">Invite people to work on {project.name} with you, as owners, collaborators or clients.</p>
        <a href={`${elsewhere.data}&next=${encodeURIComponent(next)}`} className="inline-flex items-center gap-1 rounded bg-[var(--leaf-stem)] px-2.5 py-1 font-medium text-white hover:brightness-110"><Users size={12} /> Share this project with people</a>
      </div>
    )
  }
  return (
    <div className="space-y-1.5 p-3 text-[12px]" data-testid="share-project">
      {shared ? (
        <button type="button" onClick={() => void navigate({ to: '/shared/$id', params: { id: shared.project.id } })} className="inline-flex items-center gap-1 rounded border border-[var(--bark-600)] px-2.5 py-1 text-slate-200 hover:bg-[var(--bark-700)]"><Users size={12} /> People on {project.name}</button>
      ) : (
        <>
          <p className="text-slate-300">Invite people to work on {project.name} with you, as owners, collaborators or clients.</p>
          <button
            type="button"
            disabled={share.isPending}
            onClick={() => share.mutate({ name: project.name, origin: { projectId: project.id } }, { onSuccess: (view) => void navigate({ to: '/shared/$id', params: { id: view.project.id } }) })}
            className="inline-flex items-center gap-1 rounded bg-[var(--leaf-stem)] px-2.5 py-1 font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            <Users size={12} /> {share.isPending ? 'Sharing…' : 'Share this project with people'}
          </button>
        </>
      )}
      {share.isError && <p role="alert" className="text-red-300">{errorMessage(share.error)}</p>}
    </div>
  )
}
