import { useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { AlertTriangle, FlaskConical, Network, Workflow } from 'lucide-react'
import ProcedureEditor from './ProcedureEditor'
import Explorer, { FileHeader, type ExplorerGroup } from './Explorer'
import CheckList from '../Checks/CheckList'
import { useLevel2Runs, useScenarios } from '../Checks/shared'
import { errorMessage, useAgents, useDeleteProcedure, useProcedureList, useSaveProcedure } from './shared'
import type { ProcedureSummary } from '../../api/procedures'
import { procedureIdFrom, starterProcedure } from '../../lib/procedure-drafts'
import { groupProcedures, runnersOf } from '../../lib/studio-groups'
import { checksSummary, describeChecks } from '../../lib/subject-summary'

const FILES = [
  { id: 'steps', title: 'Steps', icon: Network },
  { id: 'checks', title: 'Checks', icon: FlaskConical },
] as const

type ProcedureFile = 'overview' | typeof FILES[number]['id']

const isFile = (value: string | undefined): value is ProcedureFile => value === 'overview' || FILES.some((file) => file.id === value)

export default function ProcedureExplorer() {
  const { procedureId, part } = useParams({ strict: false }) as { procedureId?: string; part?: string }
  const navigate = useNavigate()
  const list = useProcedureList()
  const agents = useAgents()
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const save = useSaveProcedure()
  const [failure, setFailure] = useState<string>()

  const all = list.data?.procedures ?? []
  const procedure = all.find((one) => one.id === procedureId)
  const file: ProcedureFile | undefined = part === undefined ? (procedureId ? 'overview' : undefined) : isFile(part) ? part : undefined

  const groups: ExplorerGroup[] = groupProcedures(all, agents.data ?? []).map((group) => ({
    id: group.id,
    title: group.title,
    items: group.items.map((one) => {
      const checks = checksSummary(scenarios.data ?? [], runs.data ?? [], { procedure: one.id })
      return {
        id: one.id,
        label: one.name,
        mine: one.mine,
        icon: Workflow,
        link: { to: '/studio/procedures/$procedureId', params: { procedureId: one.id } },
        files: FILES.map((entry) => ({
          id: entry.id,
          title: entry.title,
          icon: entry.icon,
          link: { to: '/studio/procedures/$procedureId/$part', params: { procedureId: one.id, part: entry.id } },
          badge: entry.id === 'checks' && checks.count > 0
            ? <span className={`ml-auto text-[10px] ${checks.failing > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{checks.failing > 0 ? `${checks.failing} ✕` : `${checks.passing} ✓`}</span>
            : null,
        })),
      }
    }),
  }))

  const create = async (name: string) => {
    const id = procedureIdFrom(name)
    setFailure(undefined)
    if (!id) return setFailure('Give it a name made of letters or digits')
    if (all.some((one) => one.id === id)) return setFailure(`"${id}" is already taken`)
    try {
      const outcome = await save.mutateAsync(starterProcedure(id, name.trim()))
      if (!outcome.saved) return setFailure(outcome.problems.map((problem) => problem.message).join('; '))
      void navigate({ to: '/studio/procedures/$procedureId/$part', params: { procedureId: outcome.procedure.id, part: 'steps' } })
    } catch (err) {
      setFailure(errorMessage(err))
    }
    return undefined
  }

  const path = [
    { label: 'Procedures', link: { to: '/studio/procedures' } },
    ...(procedure ? [{ label: procedure.name, link: { to: '/studio/procedures/$procedureId', params: { procedureId: procedure.id } } }] : []),
    ...(procedure && file && file !== 'overview' ? [{ label: FILES.find((entry) => entry.id === file)?.title ?? file }] : []),
  ]

  return (
    <Explorer
      title="Procedures"
      groups={groups}
      selected={procedureId ? { item: procedureId, file: file === 'overview' ? undefined : file } : undefined}
      path={path}
      onNew={(name) => void create(name)}
      newPlaceholder="New procedure's name, then Enter"
      loading={list.isPending}
      error={list.isError ? errorMessage(list.error) : undefined}
      fill={Boolean(procedure) && file === 'steps'}
    >
      {failure && <p role="alert" className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{failure}</p>}
      {!procedureId ? (
        <Welcome unreadable={list.data?.unreadable ?? []} />
      ) : list.isPending ? null : !procedure ? (
        <p className="text-sm text-slate-400">There is no procedure called “{procedureId}”.</p>
      ) : !file ? (
        <p className="text-sm text-slate-400">{procedure.name} has no part called “{part}”.</p>
      ) : file === 'steps' ? (
        <ProcedureEditor key={procedure.id} procedureId={procedure.id} />
      ) : file === 'checks' ? (
        <div>
          <FileHeader title="Checks" says="Every check that runs it, or a step taken from it." />
          <CheckList scope={{ procedure: procedure.id }} agents={(agents.data ?? []).map((one) => one.slug)} procedures={all.map((one) => one.id)} />
        </div>
      ) : (
        <Overview procedure={procedure} />
      )}
    </Explorer>
  )
}

function Overview({ procedure }: { procedure: ProcedureSummary }) {
  const agents = useAgents()
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const runners = runnersOf(procedure.id, agents.data ?? [])

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-slate-100">
          {procedure.name}
          <span className="font-mono text-sm font-normal text-slate-500">{procedure.id} · v{procedure.version}</span>
          <span className="rounded border border-[var(--bark-600)] px-1.5 text-[10px] font-normal text-slate-400">{procedure.mine ? (procedure.ofBuiltIn ? 'your copy of a built-in' : 'yours') : 'built-in'}</span>
        </h1>
        <p className="max-w-3xl text-sm text-slate-400">{procedure.describe || 'No description yet.'}</p>
      </header>
      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Run by</h2>
        {runners.length === 0
          ? <p className="text-sm text-slate-400">No agent runs it.</p>
          : <p className="flex flex-wrap gap-2">{runners.map((slug) => <Link key={slug} to="/studio/agents/$slug" params={{ slug }} className="rounded bg-[var(--bark-800)] px-2 py-0.5 font-mono text-xs text-sky-300 hover:bg-[var(--bark-700)]">{slug}</Link>)}</p>}
      </section>
      {procedure.requires.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">What an agent running it has to be granted</h2>
          <ul className="space-y-1 text-sm">
            {procedure.requires.map((required) => (
              <li key={`${required.kind}:${required.name}`}>
                <span className="font-mono text-emerald-300">{required.name}</span>
                <span className="text-slate-500"> — {required.why}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">At a glance</h2>
        <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
          {[
            { id: 'steps', says: procedure.mine ? 'open the canvas to change it' : 'open the canvas to read it' },
            { id: 'checks', says: describeChecks(checksSummary(scenarios.data ?? [], runs.data ?? [], { procedure: procedure.id })) },
          ].map((fact) => (
            <li key={fact.id}>
              <Link to="/studio/procedures/$procedureId/$part" params={{ procedureId: procedure.id, part: fact.id }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bark-800)]/50">
                <span className="w-36 shrink-0 text-xs text-slate-400">{FILES.find((one) => one.id === fact.id)?.title}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{fact.says}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Welcome({ unreadable }: { unreadable: readonly { id: string; report: string }[] }) {
  const discard = useDeleteProcedure()
  return (
    <div className="max-w-2xl space-y-4 pt-10 text-sm text-slate-400">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-200"><Workflow size={20} className="text-[var(--leaf)]" /> Procedures</h1>
      <p>A procedure is what an agent does, laid out as nodes: building its context, calling the model, running tools, checking itself. The ones on the left are grouped by the agents that run them.</p>
      <p>Built-in procedures open read-only; make your own copy to change one, and every agent that runs it runs your copy.</p>
      {unreadable.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-300"><AlertTriangle size={13} /> Saved procedures that could not be read</h2>
          {unreadable.map((entry) => (
            <div key={entry.id} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-mono text-xs text-amber-200">{entry.id}</p>
                <button type="button" onClick={() => discard.mutate(entry.id)} disabled={discard.isPending} className="ml-auto rounded-md border border-red-900 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-950/40 disabled:opacity-40">Delete it</button>
              </div>
              <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-400">{entry.report}</pre>
              {discard.isError && <p className="mt-1 text-[11px] text-red-300">{errorMessage(discard.error)}</p>}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
