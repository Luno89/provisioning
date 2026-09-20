import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { Agent } from '../../api/agents'
import { errorMessage, useDeleteAgent, useGrantableTools, useProcedureList, useSaveAgent } from './shared'
import { NEEDS, requirementFor, toolProblem, withRequired } from './agent-forms'

const field = 'w-full rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)]'

const label = 'text-[10px] font-semibold uppercase tracking-wider text-slate-400'

export default function AgentEditor({ agent, agents, onClose }: {
  agent: Agent
  agents: readonly Agent[]
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Agent>(agent)
  const [problems, setProblems] = useState<string[]>([])
  const grantable = useGrantableTools()
  const languages = grantable.data?.languages ?? []
  const procedures = useProcedureList()
  const save = useSaveAgent(() => onClose())
  const remove = useDeleteAgent(() => onClose())

  const set = <K extends keyof Agent>(key: K, value: Agent[K]) => setDraft((current) => ({ ...current, [key]: value }))

  const requires = procedures.data?.procedures.find((one) => one.id === draft.procedure)?.requires ?? []

  const runs = (id: string) => setDraft((current) => withRequired(
    { ...current, procedure: id },
    procedures.data?.procedures.find((one) => one.id === id)?.requires ?? [],
  ))

  const toggle = (list: string[], name: string) =>
    (list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name])

  const submit = () => {
    setProblems([])
    save.mutate(draft, {
      onError: (err) => setProblems([
        errorMessage(err),
        ...((err as { response?: { data?: { problems?: string[] } } }).response?.data?.problems ?? []),
      ]),
    })
  }

  return (
    <section className="space-y-4 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/60 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-100">
          {agent.mine ? `Editing ${agent.name}` : `Your own copy of ${agent.name}`}
        </h2>
        {!agent.mine && <span className="text-[11px] text-slate-500">saving makes your copy; the built-in is untouched</span>}
        <button type="button" onClick={onClose} className="ml-auto text-[11px] text-slate-500 hover:text-slate-200">Close</button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={label}>Name</span>
          <input className={field} value={draft.name} onChange={(event) => set('name', event.target.value)} />
        </label>
        <label className="space-y-1">
          <span className={label}>Procedure it runs</span>
          <select className={field} value={draft.procedure} onChange={(event) => runs(event.target.value)}>
            {(procedures.data?.procedures ?? []).map((procedure) => (
              <option key={procedure.id} value={procedure.id}>{procedure.id}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="block space-y-1">
        <span className={label}>What it is for</span>
        <input className={field} value={draft.description} onChange={(event) => set('description', event.target.value)} />
      </label>

      <label className="block space-y-1">
        <span className={label}>Prompt</span>
        <textarea className={`${field} font-mono`} rows={8} value={draft.prompt} onChange={(event) => set('prompt', event.target.value)} />
      </label>

      <div className="space-y-1">
        <span className={label}>Workspace</span>
        <div className="flex flex-wrap gap-3 text-[11px] text-slate-300">
          {(['terminal', 'filesystem', 'git', 'egress'] as const).map((need) => (
            <label key={need} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="accent-[var(--leaf-stem)]"
                checked={draft.environment[need] === true}
                onChange={(event) => set('environment', { ...draft.environment, [need]: event.target.checked })}
              />
              {NEEDS[need] ?? need}
            </label>
          ))}
          <label className="flex items-center gap-1.5">
            Languages
            <input
              className={`${field} w-40`}
              value={(draft.environment.languages ?? []).join(', ')}
              placeholder={languages.join(', ')}
              onChange={(event) => set('environment', {
                ...draft.environment,
                languages: event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean),
              })}
            />
          </label>
        </div>
        <p className="text-[11px] text-slate-500">
          A workspace can ask for {languages.join(', ')}. The first one picks the image it starts from; the rest are installed into it, which is a build.
        </p>
      </div>

      {requires.length > 0 && (
        <div className="space-y-1 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-2">
          <span className={label}>What {draft.procedure} needs</span>
          <p className="text-[11px] text-slate-500">
            The procedure runs these steps itself, so the agent has to be granted them. They cannot be turned off while it runs this procedure.
          </p>
          <ul className="space-y-0.5">
            {requires.map((required) => (
              <li key={`${required.kind}:${required.name}`} className="text-[11px] text-slate-300">
                <span className="font-mono text-emerald-300">{required.name}</span>
                <span className="text-slate-500"> — {required.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1">
        <span className={label}>Tools it is granted</span>
        {grantable.isPending && <p className="flex items-center gap-1 text-[11px] text-slate-500"><Loader2 size={11} className="animate-spin" /> Loading tools…</p>}
        <div className="grid gap-1 sm:grid-cols-2">
          {(grantable.data?.tools ?? []).map((tool) => {
            const refusal = toolProblem(tool, draft.environment)
            const required = requirementFor(requires, 'tool', tool.name)
            return (
              <label key={tool.name} className="flex items-start gap-1.5 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--leaf-stem)]"
                  checked={draft.tools.includes(tool.name)}
                  disabled={required !== undefined}
                  title={required ? `${draft.procedure} needs this — ${required.why}` : undefined}
                  onChange={() => set('tools', toggle(draft.tools, tool.name))}
                />
                <span className="min-w-0">
                  <span className="font-mono">{tool.name}</span>
                  {required && <span className="text-emerald-300"> — {draft.procedure} needs it</span>}
                  {refusal && draft.tools.includes(tool.name) && <span className="text-amber-300"> — {refusal}</span>}
                  <span className="block truncate text-slate-500">{tool.summary}</span>
                </span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="space-y-1">
        <span className={label}>Agents it may hand work to</span>
        <div className="flex flex-wrap gap-3 text-[11px] text-slate-300">
          {agents.filter((one) => one.slug !== draft.slug).map((one) => {
            const required = requirementFor(requires, 'agent', one.slug)
            return (
              <label key={one.slug} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-[var(--leaf-stem)]"
                  checked={(draft.agents ?? []).includes(one.slug)}
                  disabled={required !== undefined}
                  title={required ? `${draft.procedure} needs this — ${required.why}` : undefined}
                  onChange={() => set('agents', toggle(draft.agents ?? [], one.slug))}
                />
                {one.slug}
                {required && <span className="text-emerald-300">— needed</span>}
              </label>
            )
          })}
        </div>
      </div>

      <label className="block space-y-1 sm:w-64">
        <span className={label}>Reply ceiling, blank for the window</span>
        <input
          className={field}
          value={draft.model?.replyCeiling ?? ''}
          placeholder="whatever the window allows"
          onChange={(event) => {
            const { replyCeiling: _was, ...rest } = draft.model ?? {}
            const wanted = event.target.value.trim()
            set('model', wanted ? { ...rest, replyCeiling: Number(wanted) } : rest)
          }}
        />
      </label>

      {problems.length > 0 && (
        <ul className="space-y-1 rounded-md border border-red-900 bg-red-950/30 p-2">
          {problems.map((problem) => <li key={problem} className="text-[11px] text-red-300">{problem}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={save.isPending}
          className="flex items-center gap-1.5 rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/20 px-3 py-1.5 text-xs font-semibold text-[var(--leaf-light)] hover:bg-[var(--leaf-stem)]/30 disabled:opacity-40"
        >
          {save.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
          {agent.mine ? 'Save' : 'Save as my own'}
        </button>
        {agent.mine && (
          <button
            type="button"
            onClick={() => remove.mutate(draft.slug)}
            className="rounded-md border border-red-900 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40"
          >
            Delete my copy
          </button>
        )}
      </div>
    </section>
  )
}
