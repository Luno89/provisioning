import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { Agent } from '../../api/agents'
import { errorMessage, useDeleteAgent, useEgressGrants, useGrantableTools, useMcpCatalogue, useProcedureList, useSaveAgent } from './shared'
import { serverLine } from './mcp-server-forms'
import { NEEDS, onlyToolsChanged, requirementFor, withRequired } from './agent-forms'
import ToolGrants from './ToolGrants'
import { ModelSelector } from '../../../models'
import AutoModeSwitch from '../AutoModeSwitch'
import { useAgentAutoMode } from '../../hooks/useAutoMode'

const field = 'w-full rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)]'

const label = 'text-[10px] font-semibold uppercase tracking-wider text-slate-400'

export type AgentSection = 'prompt' | 'procedure' | 'tools' | 'hand-offs' | 'workspace' | 'settings'

export default function AgentEditor({ agent, agents, onClose, onSaved, onDeleted, only }: {
  agent: Agent
  agents: readonly Agent[]
  only?: AgentSection | undefined
  onClose?: (() => void) | undefined
  onSaved?: ((saved: Agent) => void) | undefined
  onDeleted?: (() => void) | undefined
}) {
  const [draft, setDraft] = useState<Agent>(agent)
  const [problems, setProblems] = useState<string[]>([])
  const egress = useEgressGrants(draft.slug)
  const catalogue = useMcpCatalogue()
  const grantable = useGrantableTools()
  const languages = grantable.data?.languages ?? []
  const procedures = useProcedureList()
  const [saved, setSaved] = useState(false)
  const autoMode = useAgentAutoMode(agent.slug)
  const exists = agents.some((candidate) => candidate.slug === agent.slug)
  const save = useSaveAgent((stored) => {
    setSaved(true)
    if (onSaved) onSaved(stored)
    else onClose?.()
  })
  const remove = useDeleteAgent(() => (onDeleted ?? onClose)?.())

  const show = (section: AgentSection) => !only || only === section
  const set = <K extends keyof Agent>(key: K, value: Agent[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const concludeAfter = (wanted: string) => setDraft(({ concludeAfterMinutes: _was, ...current }) =>
    (wanted ? { ...current, concludeAfterMinutes: Number(wanted) } : current))

  const requires = procedures.data?.procedures.find((one) => one.id === draft.procedure)?.requires ?? []

  const runs = (id: string) => setDraft((current) => withRequired(
    { ...current, procedure: id },
    procedures.data?.procedures.find((one) => one.id === id)?.requires ?? [],
  ))

  const toggle = (list: string[], name: string) =>
    (list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name])

  const submit = () => {
    setProblems([])
    setSaved(false)
    save.mutate(draft, {
      onError: (err) => setProblems([
        errorMessage(err),
        ...((err as { response?: { data?: { problems?: string[] } } }).response?.data?.problems ?? []),
      ]),
    })
  }

  const staysBuiltIn = !agent.mine && onlyToolsChanged(agent, draft)

  return (
    <section className="space-y-4 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/60 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-100">
          {agent.mine || staysBuiltIn ? `Editing ${agent.name}` : `Your own copy of ${agent.name}`}
        </h2>
        {!agent.mine && (
          <span className="text-[11px] text-slate-500">
            {staysBuiltIn ? 'changing only its tools keeps it built in; changing anything else makes your copy' : 'saving makes your copy; the built-in is untouched'}
          </span>
        )}
        {saved && <span role="status" className="text-[11px] text-emerald-300">saved</span>}
        {onClose && <button type="button" onClick={onClose} className="ml-auto text-[11px] text-slate-500 hover:text-slate-200">Close</button>}
      </header>

      {(show('settings') || show('procedure')) && <div className="grid gap-3 sm:grid-cols-2">
        {show('settings') && <label className="space-y-1">
          <span className={label}>Name</span>
          <input className={field} value={draft.name} onChange={(event) => set('name', event.target.value)} />
        </label>}
        {show('procedure') && <label className="space-y-1">
          <span className={label}>Procedure it runs</span>
          <select className={field} value={draft.procedure} onChange={(event) => runs(event.target.value)}>
            {(procedures.data?.procedures ?? []).map((procedure) => (
              <option key={procedure.id} value={procedure.id}>{procedure.id}</option>
            ))}
          </select>
        </label>}
      </div>}

      {show('settings') && <label className="block space-y-1">
        <span className={label}>What it is for</span>
        <input className={field} value={draft.description} onChange={(event) => set('description', event.target.value)} />
      </label>}

      {show('prompt') && <label className="block space-y-1">
        <span className={label}>Prompt</span>
        <textarea className={`${field} font-mono leading-relaxed`} rows={only === 'prompt' ? 28 : 8} value={draft.prompt} onChange={(event) => set('prompt', event.target.value)} />
      </label>}

      {show('workspace') && <div className="space-y-1">
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
      </div>}

      {show('procedure') && requires.length > 0 && (
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

      {show('tools') && <label className="block space-y-1">
        <span className={label}>What it may do with its tools</span>
        <select
          className={field}
          value={draft.maxEffect ?? 'write'}
          onChange={(event) => set('maxEffect', event.target.value === 'write' ? undefined : event.target.value as Agent['maxEffect'])}
        >
          <option value="write">change things</option>
          <option value="propose">read and propose changes, never make them</option>
          <option value="read">only read</option>
        </select>
      </label>}

      {show('tools') && <div className="space-y-1">
        <span className={label}>Tools it is granted</span>
        {grantable.isPending && <p className="flex items-center gap-1 text-[11px] text-slate-500"><Loader2 size={11} className="animate-spin" /> Loading tools…</p>}
        {grantable.data && (
          <ToolGrants
            granted={draft.tools}
            sources={agent.toolSources ?? []}
            grantable={grantable.data.tools}
            requires={requires}
            procedure={draft.procedure}
            environment={draft.environment}
            onChange={(next) => set('tools', next)}
          />
        )}
      </div>}

      {show('workspace') && <div className="space-y-1">
        <span className={label}>Hosts it may reach from its workspace</span>
        {egress.grants.length === 0 && <p className="text-[11px] text-slate-500">Only the package registries. It can ask for more with request_egress.</p>}
        <ul className="flex flex-col gap-1 text-[11px] text-slate-300">
          {egress.grants.map((grant) => (
            <li key={grant.id} className="flex items-center gap-2">
              <span className="font-mono">{grant.host}{grant.ports?.length ? `:${grant.ports.join(',')}` : ''}</span>
              {grant.reason && <span className="text-slate-500 truncate">— {grant.reason}</span>}
              <button type="button" disabled={egress.busy} onClick={() => egress.revoke(grant.id)} className="ml-auto px-1.5 py-0.5 rounded bg-[var(--bark-700)] hover:bg-[var(--bark-600)] disabled:opacity-50 cursor-pointer">Revoke</button>
            </li>
          ))}
        </ul>
      </div>}

      {show('tools') && <div className="space-y-1">
        <span className={label}>MCP servers it holds</span>
        {(catalogue.data?.servers ?? []).length === 0 && <p className="text-[11px] text-slate-500">There are no MCP servers in your catalogue yet. Add one under Studio → MCP Servers.</p>}
        <div className="flex flex-wrap gap-3 text-[11px] text-slate-300">
          {(catalogue.data?.servers ?? []).map((server) => (
            <label key={server.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="accent-[var(--leaf-stem)]"
                checked={(draft.servers ?? []).includes(server.name)}
                onChange={() => set('servers', toggle(draft.servers ?? [], server.name))}
              />
              <span className="font-mono">{server.name}</span>
              <span className="text-slate-500">{serverLine(server)}</span>
            </label>
          ))}
        </div>
        {(draft.servers ?? []).some((name) => catalogue.data?.servers.find((server) => server.name === name)?.runs.where === 'workspace') && (
          <p className="text-[11px] text-slate-500">A server that runs in the workspace is installed in this agent's image, so holding one rebuilds it.</p>
        )}
      </div>}

      {show('hand-offs') && <div className="space-y-1">
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
      </div>}

      {show('settings') && <div className="space-y-1">
        <span className={label}>Runs on</span>
        <ModelSelector
          value={draft.model?.endpointId ?? ''}
          onChange={(id) => {
            const { endpointId: _was, ...rest } = draft.model ?? {}
            set('model', id ? { ...rest, endpointId: id } : rest)
          }}
          className="w-72"
          machines
        />
        <span className="block text-[11px] text-slate-500">A model runs in this agent's own procedure. An agent on one of your machines does the work with its own loop, tools and model, wherever this agent is handed work.</span>
      </div>}

      {show('settings') && <label className="block space-y-1 sm:w-64">
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
      </label>}

      {show('settings') && <label className="block space-y-1 sm:w-64">
        <span className={label}>A conversation concludes after this many quiet minutes</span>
        <input
          aria-label="Quiet minutes before a conversation concludes"
          className={field}
          inputMode="numeric"
          value={draft.concludeAfterMinutes ?? ''}
          placeholder="the default"
          onChange={(event) => concludeAfter(event.target.value.trim())}
        />
        <span className="block text-[11px] text-slate-500">Then what it taught is remembered. A new message starts the count again.</span>
      </label>}

      {show('settings') && exists && (
        <AutoModeSwitch
          state={autoMode}
          label="Auto mode"
          explain="Its runs never stop to ask you before a call, on your machine or on the platform. Calls inside a sandbox never ask anyway. This takes effect at once and is not part of saving the agent."
        />
      )}

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
          {agent.mine || staysBuiltIn ? 'Save' : 'Save as my own'}
        </button>
        {agent.mine && (!only || only === 'settings') && (
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
