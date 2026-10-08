import { useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { FileText, FlaskConical, ListChecks, Wrench } from 'lucide-react'
import type { EngineTool } from '../../api/engineTools'
import ToolEditor from './ToolEditor'
import McpToolKinds from './McpToolKinds'
import Explorer, { FileHeader, type ExplorerGroup } from './Explorer'
import CheckList from '../Checks/CheckList'
import Coverage from '../Checks/Coverage'
import { useLevel2Runs, useScenarios } from '../Checks/shared'
import { errorMessage, useAgents, useEngineTools, useProcedureList } from './shared'
import { blankTool } from './tool-forms'
import { groupTools } from '../../lib/studio-groups'
import { checksSummary, describeChecks } from '../../lib/subject-summary'

const FILES = [
  { id: 'definition', title: 'Definition', icon: FileText, says: 'What it does, the arguments it takes, the command it runs and what it needs installed.' },
  { id: 'checks', title: 'Checks', icon: FlaskConical, says: 'Every check that expects it to be called or chosen, or calls it as its step.' },
  { id: 'coverage', title: 'Coverage', icon: ListChecks, says: 'How reliably a model picks it when it should, and what no check covers yet.' },
] as const

type ToolFile = 'overview' | typeof FILES[number]['id']

const isFile = (value: string | undefined): value is ToolFile => value === 'overview' || FILES.some((file) => file.id === value)

export default function ToolExplorer() {
  const { name, part } = useParams({ strict: false }) as { name?: string; part?: string }
  const navigate = useNavigate()
  const tools = useEngineTools()
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const [fresh, setFresh] = useState<EngineTool>()

  const all = tools.data ?? []
  const tool = all.find((one) => one.name === name)
  const file: ToolFile | undefined = part === undefined ? (name ? 'overview' : undefined) : isFile(part) ? part : undefined

  const groups: ExplorerGroup[] = groupTools(all).map((group) => ({
    id: group.id,
    title: group.title,
    items: group.items.map((one) => {
      const checks = checksSummary(scenarios.data ?? [], runs.data ?? [], { tool: one.name })
      return {
        id: one.name,
        label: one.name,
        mono: true,
        mine: one.mine,
        icon: Wrench,
        link: { to: '/studio/tools/$name', params: { name: one.name } },
        files: FILES.map((entry) => ({
          id: entry.id,
          title: entry.title,
          icon: entry.icon,
          link: { to: '/studio/tools/$name/$part', params: { name: one.name, part: entry.id } },
          badge: entry.id === 'checks' && checks.count > 0
            ? <span className={`ml-auto text-[10px] ${checks.failing > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{checks.failing > 0 ? `${checks.failing} ✕` : `${checks.passing} ✓`}</span>
            : null,
        })),
      }
    }),
  }))

  const start = (wanted: string) => {
    const slug = wanted.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    if (slug) setFresh(blankTool(slug))
  }

  const path = [
    { label: 'Tools', link: { to: '/studio/tools' } },
    ...(fresh ? [{ label: `${fresh.name} (new)` }] : []),
    ...(!fresh && tool ? [{ label: tool.name, link: { to: '/studio/tools/$name', params: { name: tool.name } } }] : []),
    ...(!fresh && tool && file && file !== 'overview' ? [{ label: FILES.find((entry) => entry.id === file)?.title ?? file }] : []),
  ]

  return (
    <Explorer
      title="Tools"
      groups={groups}
      selected={name ? { item: name, file: file === 'overview' ? undefined : file } : undefined}
      path={path}
      onNew={start}
      newPlaceholder="New tool's name, then Enter"
      loading={tools.isPending}
      error={tools.isError ? errorMessage(tools.error) : undefined}
    >
      {fresh ? (
        <ToolEditor key={fresh.name} tool={fresh} onClose={() => { setFresh(undefined); void navigate({ to: '/studio/tools/$name', params: { name: fresh.name } }) }} />
      ) : !name ? (
        <div className="max-w-xl space-y-4 pt-10 text-sm text-slate-400">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-200"><Wrench size={20} className="text-[var(--leaf)]" /> Tools</h1>
          <p>A tool is something an agent may call. The ones on the left are grouped by what they act on and how far they go: your workspace, the web, or the platform — looking, proposing, or changing.</p>
          <p>A tool you write is a command run in the workspace, with the arguments it takes and the binary it needs. Saying how to install that binary is what puts it in the workspace image, so changing it rebuilds the workspace of every agent granted it.</p>
          <McpToolKinds />
        </div>
      ) : tools.isPending ? null : !tool ? (
        <p className="text-sm text-slate-400">There is no tool called “{name}”.</p>
      ) : !file ? (
        <p className="text-sm text-slate-400">{tool.name} has no part called “{part}”.</p>
      ) : (
        <ToolFileView key={`${tool.name}-${file}`} tool={tool} file={file} />
      )}
    </Explorer>
  )
}

function ToolFileView({ tool, file }: { tool: EngineTool; file: ToolFile }) {
  const navigate = useNavigate()
  const agents = useAgents()
  const procedures = useProcedureList()
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const slugs = (agents.data ?? []).map((one) => one.slug)
  const procedureIds = (procedures.data?.procedures ?? []).map((one) => one.id)
  const entry = FILES.find((one) => one.id === file)

  if (file === 'overview') {
    return (
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-slate-100">
            <span className="font-mono">{tool.name}</span>
            <span className="rounded border border-[var(--bark-600)] px-1.5 text-[10px] font-normal text-slate-400">{tool.mine ? 'yours' : 'built-in'}</span>
          </h1>
          <p className="max-w-3xl text-sm text-slate-400">{tool.summary}</p>
        </header>
        <section className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Held by</h2>
          {tool.grantedTo.length === 0
            ? <p className="text-sm text-slate-400">No agent holds it.</p>
            : <p className="flex flex-wrap gap-2 text-sm">{tool.grantedTo.map((slug) => <Link key={slug} to="/studio/agents/$slug" params={{ slug }} className="rounded bg-[var(--bark-800)] px-2 py-0.5 font-mono text-xs text-sky-300 hover:bg-[var(--bark-700)]">{slug}</Link>)}</p>}
        </section>
        <section className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">At a glance</h2>
          <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
            {[
              { id: 'definition', says: `${tool.effect === 'read' ? 'only reads' : tool.effect === 'propose' ? 'proposes, never changes' : 'changes things'} · ${tool.command ? `runs ${tool.command}` : `${tool.binding} tool`}` },
              { id: 'checks', says: describeChecks(checksSummary(scenarios.data ?? [], runs.data ?? [], { tool: tool.name })) },
            ].map((fact) => (
              <li key={fact.id}>
                <Link to="/studio/tools/$name/$part" params={{ name: tool.name, part: fact.id }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bark-800)]/50">
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

  return (
    <div>
      <FileHeader title={entry?.title ?? file} says={entry?.says} />
      {file === 'definition' && <ToolEditor key={`${tool.name}-${tool.mine}`} tool={tool} onDeleted={() => void navigate({ to: '/studio/tools' })} />}
      {file === 'checks' && <CheckList scope={{ tool: tool.name }} agents={tool.grantedTo.length > 0 ? tool.grantedTo : slugs} procedures={procedureIds} />}
      {file === 'coverage' && <Coverage scope={{ tool: tool.name }} />}
    </div>
  )
}
