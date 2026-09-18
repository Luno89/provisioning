import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, Loader2, Network, Plus } from 'lucide-react'
import { BUILT_IN_PROCEDURES } from '@koala/agent-engine/procedure'
import { procedureIdFrom, starterProcedure } from '../../lib/procedure-drafts'
import { errorMessage, useProcedureList, useSaveProcedure } from './shared'

const BUILT_IN_IDS = new Set(BUILT_IN_PROCEDURES.map((procedure) => procedure.id))

export default function StudioView() {
  const navigate = useNavigate()
  const list = useProcedureList()
  const save = useSaveProcedure()
  const [name, setName] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const id = name ? procedureIdFrom(name) : ''
  const taken = new Set(list.data?.procedures.map((procedure) => procedure.id) ?? [])
  const refusal = name === null ? undefined : !id ? 'Give it a name' : taken.has(id) ? `"${id}" is already taken` : undefined

  const create = async () => {
    if (name === null || refusal) return
    setFailure(null)
    try {
      const outcome = await save.mutateAsync(starterProcedure(id, name.trim()))
      if (!outcome.saved) {
        setFailure(outcome.problems.map((problem) => problem.message).join('; '))
        return
      }
      void navigate({ to: '/studio/$procedureId', params: { procedureId: outcome.procedure.id } })
    } catch (err) {
      setFailure(errorMessage(err))
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-100">
            <Network size={22} className="text-[var(--leaf)]" /> Procedure Studio
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm text-slate-400">
            A procedure is what an agent does, laid out as nodes: building its context, calling the model, running tools, checking itself. Open one to see every step, change it, and run it.
          </p>
        </div>
        {name === null ? (
          <button
            type="button"
            onClick={() => setName('')}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/20 px-3 py-1.5 text-xs font-semibold text-[var(--leaf-light)] hover:bg-[var(--leaf-stem)]/30"
          >
            <Plus size={14} /> New procedure
          </button>
        ) : (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input
              autoFocus
              aria-label="Name of the new procedure"
              placeholder="What should it be called?"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
                if (event.key === 'Escape') setName(null)
              }}
              className="w-64 rounded-md border border-[var(--bark-600)] bg-[var(--bark-800)] px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)]"
            />
            <button
              type="button"
              disabled={Boolean(refusal) || save.isPending}
              onClick={() => void create()}
              className="flex items-center gap-1.5 rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/20 px-3 py-1.5 text-xs font-semibold text-[var(--leaf-light)] disabled:opacity-40"
            >
              {save.isPending && <Loader2 size={12} className="animate-spin" />} Create
            </button>
            <button type="button" onClick={() => setName(null)} className="text-xs text-slate-400 hover:text-slate-200">Cancel</button>
            <span className="w-full text-right text-[11px] text-slate-500">{refusal ?? `id: ${id}`}</span>
          </div>
        )}
      </header>

      {failure && <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{failure}</p>}

      {list.isPending && <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading procedures…</p>}
      {list.isError && <p className="text-sm text-red-300">{errorMessage(list.error)}</p>}

      {list.data && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.data.procedures.map((procedure) => (
            <li key={procedure.id}>
              <Link
                to="/studio/$procedureId"
                params={{ procedureId: procedure.id }}
                className="block h-full rounded-lg border border-[var(--bark-700)] bg-[var(--bark-800)]/60 p-4 transition-colors hover:border-[var(--leaf-stem)]/60 hover:bg-[var(--bark-800)]"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-100">{procedure.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${procedure.mine ? 'bg-[var(--leaf-stem)]/25 text-[var(--leaf-light)]' : 'bg-sky-500/10 text-sky-300'}`}>
                    {procedure.mine ? (BUILT_IN_IDS.has(procedure.id) ? 'your copy of a built-in' : 'yours') : 'built-in'}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-slate-500">{procedure.id} · v{procedure.version}</p>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">{procedure.describe || 'No description yet.'}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {list.data && list.data.unreadable.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-300">
            <AlertTriangle size={13} /> Saved procedures that could not be read
          </h2>
          {list.data.unreadable.map((entry) => (
            <div key={entry.id} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="font-mono text-xs text-amber-200">{entry.id}</p>
              <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-400">{entry.report}</pre>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
