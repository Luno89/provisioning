import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Rocket } from 'lucide-react'
import { getProjectRelease, getReleaseOptions, releaseSettingKeys, setProjectRelease, type ReleaseHow } from '../api/release-settings'
import { errorMessage } from '../../../api/client'

const describe = (how: ReleaseHow, name?: string) => `${name ?? how.agent}${how.app ? ` · ${how.app}` : ''}`

export function ProjectRelease({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: current } = useQuery({ queryKey: releaseSettingKeys.project(projectId), queryFn: () => getProjectRelease(projectId) })
  const { data: options } = useQuery({ queryKey: releaseSettingKeys.options(), queryFn: getReleaseOptions })
  const change = useMutation({
    mutationFn: (release: ReleaseHow | null) => setProjectRelease(projectId, release),
    onSuccess: (saved) => qc.setQueryData(releaseSettingKeys.project(projectId), saved),
  })
  if (!current) return null
  const agents = options?.agents ?? []
  const apps = options?.apps ?? []
  const named = agents.find((agent) => agent.slug === current.how.agent)?.name

  const pick = (value: string) => {
    if (value === '') return change.mutate(null)
    const [agent, app] = value.split('|')
    change.mutate({ agent: agent!, ...(app ? { app } : {}) })
  }
  const choices = agents.flatMap((agent) => (agent.needsApp ? apps.map((app) => ({ value: `${agent.slug}|${app.id}`, label: `${agent.name} · ${app.title}` })) : [{ value: agent.slug, label: agent.name }]))
  const overridden = current.from === 'project'

  return (
    <div className="space-y-1.5">
      <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
        <Rocket size={11} /> Release
      </h4>
      <p className="text-[11px] text-slate-400">
        Builds are released by <span className="text-slate-200">{describe(current.how, named)}</span>
        {current.from === 'tree type' ? ', as its tree type says' : current.from === 'repository' ? ', from what its repository holds' : ', set for this project'}.
      </p>
      <select
        aria-label="How this project's builds are released"
        className="w-full max-w-sm bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-lg px-3 py-1.5 text-xs text-slate-200"
        value={overridden ? `${current.how.agent}${current.how.app ? `|${current.how.app}` : ''}` : ''}
        disabled={change.isPending}
        onChange={(event) => pick(event.target.value)}
      >
        <option value="">the way its tree type does</option>
        {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
      {change.isError && <p className="text-[11px] text-rose-400">{errorMessage(change.error) || 'Could not change how it is released.'}</p>}
    </div>
  )
}

export default ProjectRelease
