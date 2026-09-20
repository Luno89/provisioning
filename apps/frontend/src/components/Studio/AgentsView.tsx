import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import type { Agent, AgentImage } from '../../api/agents'
import AgentEditor from './AgentEditor'
import { errorMessage, useAgents, useProcedureList } from './shared'
import { blankAgent } from './agent-forms'

const IMAGE: Record<AgentImage['state'], { says: string; className: string }> = {
  ready: { says: 'workspace ready', className: 'text-slate-500' },
  building: { says: 'building its workspace', className: 'text-amber-300' },
  failed: { says: 'workspace did not build', className: 'text-red-300' },
  unbuilt: { says: 'workspace not built yet', className: 'text-slate-500' },
}

export default function AgentsView() {
  const agents = useAgents()
  const procedures = useProcedureList()
  const [open, setOpen] = useState<string>()
  const [fresh, setFresh] = useState<Agent>()
  const [name, setName] = useState('')

  const editing = fresh ?? agents.data?.find((agent) => agent.slug === open)

  const start = () => {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (!slug) return
    setOpen(undefined)
    setFresh({ ...blankAgent(procedures.data?.procedures[0]?.id ?? 'tool-rounds'), slug, name: name.trim() })
    setName('')
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <p className="max-w-2xl text-sm text-slate-400">
          An agent is a procedure plus what it is allowed to touch: its prompt, the tools it is granted, the agents it can hand work to, and the workspace it runs in. What it is granted decides what its workspace image contains, so saving rebuilds it.
        </p>
        <div className="ml-auto flex items-center gap-2">
          <input
            aria-label="Name of the new agent"
            className="w-48 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)]"
            placeholder="New agent's name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') start() }}
          />
          <button
            type="button"
            onClick={start}
            disabled={!name.trim()}
            className="flex items-center gap-1.5 rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/20 px-3 py-1.5 text-xs font-semibold text-[var(--leaf-light)] hover:bg-[var(--leaf-stem)]/30 disabled:opacity-40"
          >
            <Plus size={14} /> New agent
          </button>
        </div>
      </div>

      {agents.isPending && <p className="flex items-center gap-1.5 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Loading agents…</p>}
      {agents.isError && <p className="text-xs text-red-300">{errorMessage(agents.error)}</p>}

      {editing && (
        <AgentEditor
          key={editing.slug}
          agent={editing}
          agents={agents.data ?? []}
          onClose={() => { setFresh(undefined); setOpen(undefined) }}
        />
      )}

      <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
        {(agents.data ?? []).map((agent) => (
          <li key={agent.slug}>
            <button
              type="button"
              onClick={() => { setFresh(undefined); setOpen(agent.slug === open ? undefined : agent.slug) }}
              className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bark-800)]/40"
            >
              <span className="font-mono text-sm text-slate-200">{agent.slug}</span>
              <span className="rounded border border-[var(--bark-600)] px-1 text-[10px] text-slate-400">
                {agent.mine ? 'yours' : 'built-in'}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{agent.description}</span>
              <span className="shrink-0 font-mono text-[11px] text-slate-500">{agent.procedure}</span>
              <span className="shrink-0 text-[11px] text-slate-500">
                {agent.tools.length} {agent.tools.length === 1 ? 'tool' : 'tools'}
              </span>
              {agent.image && (
                <span className={`shrink-0 text-[11px] ${IMAGE[agent.image.state].className}`}>
                  {IMAGE[agent.image.state].says}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
