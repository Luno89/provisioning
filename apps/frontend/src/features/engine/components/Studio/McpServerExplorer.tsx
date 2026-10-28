import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { AlertTriangle, CheckCircle2, FileText, Loader2, RefreshCw, Server } from 'lucide-react'
import type { McpServer, McpServerRuns, McpToolKind } from '../../api/mcp'
import type { Agent } from '../../api/agents'
import Explorer, { FileHeader } from './Explorer'
import { SERVER_FILES, serverItem, useToolbox } from './toolbox'
import { ToolNotesPanel } from '../../../checks'
import NeedsPicker from '../NeedsPicker'
import { errorMessage, useAddMcpServer, useAgents, useCaptureMcpServer, useRemoveMcpServer, useSaveAgent, useSaveMcpServer } from './shared'
import {
  PLACE_TITLES, declaredKind, formOf, isOffered, placeOf, runsOf, statusText, withOffered, withToolSaid, type WorkspaceForm,
} from './mcp-server-forms'

const FILES = SERVER_FILES

type ServerFile = 'overview' | typeof FILES[number]['id']

const isFile = (value: string | undefined): value is ServerFile => value === 'overview' || FILES.some((file) => file.id === value)

const field = 'w-full rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200'
const label = 'text-[11px] font-medium text-slate-400'
const button = 'rounded border border-[var(--bark-600)] px-2 py-1 text-xs text-slate-200 hover:bg-[var(--bark-700)] disabled:opacity-50'
const primary = 'rounded bg-[var(--leaf-stem)] px-2.5 py-1 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50'

function Status({ server }: { server: McpServer }) {
  const state = server.status.state
  const tone = state === 'captured' ? 'text-emerald-300' : state === 'failed' ? 'text-rose-300' : 'text-amber-300'
  const Icon = state === 'captured' ? CheckCircle2 : state === 'capturing' ? Loader2 : AlertTriangle
  return (
    <span className={`flex items-center gap-1 text-xs ${tone}`}>
      <Icon size={12} className={state === 'capturing' ? 'animate-spin' : ''} aria-hidden="true" /> {statusText(server)}
    </span>
  )
}

export default function McpServerExplorer() {
  const { id, part } = useParams({ strict: false }) as { id?: string; part?: string }
  const toolbox = useToolbox((one, entry) => (entry === 'tools' ? <span className="ml-auto"><Status server={one} /></span> : null))
  const catalogue = toolbox.catalogue
  const [adding, setAdding] = useState<string | undefined>()

  const servers = catalogue.data?.servers ?? []
  const server = servers.find((one) => one.id === id)
  const file: ServerFile | undefined = part === undefined ? (id ? 'overview' : undefined) : isFile(part) ? part : undefined

  const path = [
    { label: 'Tools', link: { to: '/studio/tools' } },
    { label: 'MCP servers', link: { to: '/studio/mcp-servers' } },
    ...(server ? [{ label: server.name, link: { to: '/studio/mcp-servers/$id', params: { id: server.id } } }] : []),
    ...(server && file && file !== 'overview' ? [{ label: FILES.find((entry) => entry.id === file)?.title ?? file }] : []),
  ]

  return (
    <Explorer
      title="Tools"
      groups={toolbox.groups}
      selected={id ? { item: serverItem(id), file: file === 'overview' ? undefined : file } : undefined}
      path={path}
      onNew={(name) => setAdding(name)}
      newPlaceholder="New server's name, then Enter"
      loading={catalogue.isPending}
      error={catalogue.isError ? errorMessage(catalogue.error) : undefined}
    >
      {!id || adding !== undefined ? (
        <Landing templates={catalogue.data?.templates ?? []} naming={adding} onDone={() => setAdding(undefined)} />
      ) : catalogue.isPending ? null : !server ? (
        <p className="text-sm text-slate-400">There is no MCP server here with that id.</p>
      ) : !file ? (
        <p className="text-sm text-slate-400">{server.name} has no part called “{part}”.</p>
      ) : (
        <ServerFileView key={`${server.id}-${file}-${server.updatedAt}`} server={server} file={file} />
      )}
    </Explorer>
  )
}

function Landing({ templates, naming, onDone }: { templates: { id: string; name: string; summary: string; added: boolean }[]; naming?: string | undefined; onDone: () => void }) {
  const navigate = useNavigate()
  const add = useAddMcpServer((server) => { onDone(); void navigate({ to: '/studio/mcp-servers/$id', params: { id: server.id } }) })
  const [how, setHow] = useState<'url' | 'workspace'>('url')
  const [name, setName] = useState(naming ?? '')
  const [url, setUrl] = useState('')
  const [form, setForm] = useState<WorkspaceForm>(() => formOf({ where: 'workspace', needs: [], start: '', port: 8931 }))

  return (
    <div className="max-w-3xl space-y-6 pt-4 text-sm text-slate-400">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-200"><Server size={20} className="text-[var(--leaf)]" /> MCP Servers</h1>
      <p>An MCP server serves tools of its own. Adding one captures it: it is started, or reached, and asked what it says about itself and which tools it serves. Runs offer those tools from that capture, as <span className="font-mono">name__tool</span>, to the agents holding it, with its instructions and your notes.</p>
      <p>One that runs in the workspace is installed in the image of every agent holding it. Your own deployments that answer MCP are listed here as they run.</p>

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Known servers</h2>
        <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
          {templates.map((template) => (
            <li key={template.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-28 shrink-0 font-mono text-slate-200">{template.name}</span>
              <span className="min-w-0 flex-1 text-xs">{template.summary}</span>
              <button type="button" disabled={add.isPending} onClick={() => add.mutate({ template: template.id })} className={button}>
                {template.added ? 'Add another' : 'Add'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3 rounded-md border border-[var(--bark-700)] p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Add your own</h2>
        <div className="flex gap-2 text-xs">
          {(['url', 'workspace'] as const).map((choice) => (
            <button key={choice} type="button" aria-pressed={how === choice} onClick={() => setHow(choice)} className={`rounded px-2 py-1 ${how === choice ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
              {choice === 'url' ? PLACE_TITLES.url : PLACE_TITLES.workspace}
            </button>
          ))}
        </div>
        <label className="block space-y-1">
          <span className={label}>Name — its tools are offered as name__tool</span>
          <input aria-label="Server name" className={`${field} font-mono`} value={name} onChange={(event) => setName(event.target.value)} placeholder="docs" />
        </label>
        {how === 'url' ? (
          <label className="block space-y-1">
            <span className={label}>Address it answers MCP at</span>
            <input aria-label="Server address" className={`${field} font-mono`} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://docs.example.internal/mcp" />
          </label>
        ) : (
          <WorkspaceFields form={form} onChange={setForm} />
        )}
        <button
          type="button"
          disabled={add.isPending || !name.trim()}
          onClick={() => add.mutate({ name: name.trim(), runs: how === 'url' ? { where: 'hosted', url: url.trim() } : runsOf(form) })}
          className={primary}
        >
          {add.isPending ? 'Adding…' : 'Add and capture'}
        </button>
        {add.error && <p className="text-xs text-rose-300">{errorMessage(add.error)}</p>}
      </section>
    </div>
  )
}

function WorkspaceFields({ form, onChange }: { form: WorkspaceForm; onChange: (form: WorkspaceForm) => void }) {
  const set = <K extends keyof WorkspaceForm>(key: K, value: WorkspaceForm[K]) => onChange({ ...form, [key]: value })
  return (
    <div className="space-y-3">
      <NeedsPicker value={form.needs} onChange={(needs) => set('needs', needs)} />
      <label className="block space-y-1">
        <span className={label}>Command that starts it</span>
        <input aria-label="Start command" className={`${field} font-mono`} value={form.start} onChange={(event) => set('start', event.target.value)} placeholder="my-server --port 8931" />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className={label}>Port it answers on</span>
          <input aria-label="Port" inputMode="numeric" className={`${field} font-mono`} value={form.port} onChange={(event) => set('port', event.target.value)} />
        </label>
        <label className="space-y-1">
          <span className={label}>Path</span>
          <input aria-label="Path" className={`${field} font-mono`} value={form.path} onChange={(event) => set('path', event.target.value)} placeholder="/mcp" />
        </label>
        <label className="space-y-1">
          <span className={label}>Languages it needs</span>
          <input aria-label="Languages" className={`${field} font-mono`} value={form.languages.join(', ')} onChange={(event) => set('languages', event.target.value.split(/[\s,]+/).filter(Boolean))} placeholder="node" />
        </label>
      </div>
    </div>
  )
}

function ServerFileView({ server, file }: { server: McpServer; file: ServerFile }) {
  const entry = FILES.find((one) => one.id === file)
  if (file === 'overview') return <Overview server={server} />
  return (
    <div>
      <FileHeader title={entry?.title ?? file} says={entry?.says} />
      {file === 'runs' && <HowItRuns server={server} />}
      {file === 'tools' && <Tools server={server} />}
      {file === 'notes' && <Notes server={server} />}
      {file === 'learned' && <ToolNotesPanel scope={{ server: server.name }} />}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
      {children}
    </section>
  )
}

function Overview({ server }: { server: McpServer }) {
  const capture = useCaptureMcpServer()
  const agents = useAgents()
  const grant = useSaveAgent()
  const holders = (agents.data ?? []).filter((agent) => (agent.servers ?? []).includes(server.name))
  const toggle = (agent: Agent, held: boolean) => grant.mutate({ ...agent, servers: held ? [...new Set([...(agent.servers ?? []), server.name])] : (agent.servers ?? []).filter((name) => name !== server.name) })

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex flex-wrap items-center gap-3 text-xl font-semibold text-slate-100">
          <span className="font-mono">{server.name}</span>
          <span className="rounded border border-[var(--bark-600)] px-1.5 text-[10px] font-normal text-slate-400">{PLACE_TITLES[placeOf(server.runs)]}</span>
          <Status server={server} />
          <button type="button" disabled={capture.isPending || server.status.state === 'capturing'} onClick={() => capture.mutate(server.id)} className={`${button} ml-auto flex items-center gap-1 font-normal`}>
            <RefreshCw size={12} aria-hidden="true" /> Capture again
          </button>
        </h1>
        {server.summary && <p className="max-w-3xl text-sm text-slate-400">{server.summary}</p>}
        {capture.error && <p className="text-xs text-rose-300">{errorMessage(capture.error)}</p>}
      </header>

      {server.status.state === 'failed' && (
        <p role="alert" className="whitespace-pre-wrap rounded border border-rose-900/60 bg-rose-950/30 p-3 font-mono text-xs text-rose-200">{server.status.why}</p>
      )}
      {server.status.state === 'stale' && <p className="text-xs text-amber-300">How it runs changed since it was captured, so it is offered to no one until it is captured again.</p>}
      {server.status.state === 'capturing' && <p className="text-xs text-amber-200">Being captured{placeOf(server.runs) === 'workspace' ? ': its image is built (minutes, the first time), then it is started and asked' : ''}. Its tools are offered once it answers.</p>}

      <Section title="What it says about itself">
        {server.captured
          ? <p className="max-w-3xl whitespace-pre-wrap text-sm text-slate-300">{server.captured.instructions ?? 'It gives no instructions of its own.'}{server.captured.serverInfo?.name ? <span className="block pt-1 text-xs text-slate-500">{server.captured.serverInfo.name} {server.captured.serverInfo.version ?? ''} · captured {new Date(server.captured.at).toLocaleString()}</span> : null}</p>
          : <p className="text-sm text-slate-500">Nothing yet: it has not been captured.</p>}
      </Section>

      <Section title="Held by">
        <div className="flex flex-wrap gap-3 text-xs text-slate-300">
          {(agents.data ?? []).map((agent) => {
            const held = holders.includes(agent)
            return (
              <label key={agent.slug} className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-[var(--leaf-stem)]" checked={held} disabled={grant.isPending} onChange={() => toggle(agent, !held)} />
                <Link to="/studio/agents/$slug" params={{ slug: agent.slug }} className="font-mono text-sky-300 hover:underline">{agent.slug}</Link>
              </label>
            )
          })}
        </div>
        {placeOf(server.runs) === 'workspace' && <p className="text-[11px] text-slate-500">Giving it to an agent installs it in that agent's image, which then rebuilds.</p>}
        {grant.error && <p className="text-xs text-rose-300">{errorMessage(grant.error)}</p>}
      </Section>

      <Section title="Used by projects">
        {placeOf(server.runs) === 'workspace'
          ? <p className="text-sm text-slate-400">It runs inside a project's workspace, so the people on any shared project reach it there, at their role's level.</p>
          : (server.projectsNamed ?? []).length
            ? <p className="text-sm text-slate-300">{(server.projectsNamed ?? []).map((project) => project.name).join(', ')}. The people on these shared projects reach its tools at their role's level; attach or detach it in a project's Settings.</p>
            : <p className="text-sm text-slate-400">No project. Only you reach it; attach it in a project's Settings to let the people on that shared project use it.</p>}
      </Section>

      <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
        {FILES.map((entry) => (
          <li key={entry.id}>
            <Link to="/studio/mcp-servers/$id/$part" params={{ id: server.id, part: entry.id }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bark-800)]/50">
              <entry.icon size={13} className="text-slate-500" />
              <span className="w-32 shrink-0 text-xs text-slate-400">{entry.title}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{entry.says}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function HowItRuns({ server }: { server: McpServer }) {
  const navigate = useNavigate()
  const save = useSaveMcpServer(server.id)
  const remove = useRemoveMcpServer(() => void navigate({ to: '/studio/mcp-servers' }))
  const [name, setName] = useState(server.name)
  const [summary, setSummary] = useState(server.summary ?? '')
  const [url, setUrl] = useState(server.runs.where === 'hosted' && 'url' in server.runs ? server.runs.url : '')
  const [form, setForm] = useState<WorkspaceForm | undefined>(() => (server.runs.where === 'workspace' ? formOf(server.runs) : undefined))
  const [confirming, setConfirming] = useState(false)
  const place = placeOf(server.runs)

  const runs: McpServerRuns = form ? runsOf(form) : place === 'url' ? { where: 'hosted', url: url.trim() } : server.runs

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={label}>Name — renaming moves it with every agent holding it</span>
          <input aria-label="Server name" className={`${field} font-mono`} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="space-y-1">
          <span className={label}>What it is for</span>
          <input aria-label="Summary" className={field} value={summary} onChange={(event) => setSummary(event.target.value)} />
        </label>
      </div>
      {place === 'url' && (
        <label className="block space-y-1">
          <span className={label}>Address it answers MCP at</span>
          <input aria-label="Server address" className={`${field} font-mono`} value={url} onChange={(event) => setUrl(event.target.value)} />
        </label>
      )}
      {place === 'deployment' && <p className="text-xs text-slate-400">It is one of your deployments, reached where the cluster serves it. It leaves the catalogue when the deployment is removed.</p>}
      {form && <WorkspaceFields form={form} onChange={setForm} />}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={save.isPending} onClick={() => save.mutate({ name: name.trim(), summary: summary.trim(), runs })} className={primary}>{save.isPending ? 'Saving…' : 'Save'}</button>
        {place !== 'deployment' && (confirming
          ? <>
              <span className="text-xs text-amber-300">Remove it, and take it from every agent holding it?</span>
              <button type="button" disabled={remove.isPending} onClick={() => remove.mutate(server.id)} className="rounded bg-rose-700 px-2 py-1 text-xs text-white hover:bg-rose-600">Remove</button>
              <button type="button" onClick={() => setConfirming(false)} className={button}>Keep</button>
            </>
          : <button type="button" onClick={() => setConfirming(true)} className={`${button} ml-auto`}>Remove…</button>)}
      </div>
      {save.error && <p className="text-xs text-rose-300">{errorMessage(save.error)}</p>}
      {remove.error && <p className="text-xs text-rose-300">{errorMessage(remove.error)}</p>}
    </div>
  )
}

function Tools({ server }: { server: McpServer }) {
  const save = useSaveMcpServer(server.id)
  const tools = server.captured?.tools ?? []
  if (tools.length === 0) return <p className="text-sm text-slate-500">{server.captured ? 'It serves no tools.' : 'It has not been captured yet, so nothing knows which tools it serves.'}</p>
  const setKind = (tool: string, kind: McpToolKind | '') => save.mutate({ tools: withToolSaid(server, tool, { kind }) })
  const setNote = (tool: string, note: string) => save.mutate({ tools: withToolSaid(server, tool, { note }) })
  const setOffered = (tool: string, offered: boolean) => save.mutate(withOffered(server, tool, offered))

  return (
    <div className="space-y-3">
      {save.error && <p className="text-xs text-rose-300">{errorMessage(save.error)}</p>}
      <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
        {tools.map((tool) => {
          const offered = isOffered(server, tool.name)
          const declared = declaredKind(tool.annotations)
          const args = Object.keys((tool.inputSchema?.properties ?? {}) as Record<string, unknown>)
          return (
            <li key={tool.name} className={`space-y-1.5 px-4 py-3 ${offered ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" aria-label={`Offer ${tool.name}`} className="accent-[var(--leaf-stem)]" checked={offered} disabled={save.isPending} onChange={() => setOffered(tool.name, !offered)} />
                  <span className="font-mono text-slate-200">{server.name}__{tool.name}</span>
                </label>
                <select
                  aria-label={`What ${tool.name} does`}
                  className="ml-auto rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-1.5 py-0.5 text-[11px] text-slate-200"
                  value={server.tools?.[tool.name]?.kind ?? ''}
                  disabled={save.isPending}
                  onChange={(event) => setKind(tool.name, event.target.value as McpToolKind | '')}
                >
                  <option value="">as the server says: {declared}</option>
                  <option value="read-only">only reads</option>
                  <option value="safe-write">changes things, safely</option>
                  <option value="destructive">can destroy things</option>
                </select>
              </div>
              {tool.description && <p className="text-xs text-slate-400">{tool.description}</p>}
              {args.length > 0 && <p className="font-mono text-[11px] text-slate-500">takes {args.join(', ')}</p>}
              <NoteField key={server.tools?.[tool.name]?.note ?? ''} note={server.tools?.[tool.name]?.note ?? ''} onSave={(note) => setNote(tool.name, note)} busy={save.isPending} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function NoteField({ note, onSave, busy }: { note: string; onSave: (note: string) => void; busy: boolean }) {
  const [draft, setDraft] = useState(note)
  return (
    <div className="flex items-center gap-2">
      <input aria-label="Note for the model" className={field} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="a note the model reads beside it" />
      {draft !== note && <button type="button" disabled={busy} onClick={() => onSave(draft)} className={button}>Save note</button>}
    </div>
  )
}

function Notes({ server }: { server: McpServer }) {
  const save = useSaveMcpServer(server.id)
  const [notes, setNotes] = useState(server.notes ?? '')
  const [dependsOn, setDependsOn] = useState(server.dependsOn ?? '')
  const edited = notes !== (server.notes ?? '') || dependsOn !== (server.dependsOn ?? '')
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className={label}>Notes for every agent holding it</span>
        <textarea aria-label="Notes" rows={5} className={field} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className={label}>What it depends on</span>
        <input aria-label="Depends on" className={field} value={dependsOn} onChange={(event) => setDependsOn(event.target.value)} placeholder="the kept Odoo on http://localhost:8069" />
      </label>
      {edited && (
        <button type="button" disabled={save.isPending} onClick={() => save.mutate({ notes: notes.trim() || null, dependsOn: dependsOn.trim() || null })} className={primary}>
          Save notes
        </button>
      )}
      {save.error && <p className="text-xs text-rose-300">{errorMessage(save.error)}</p>}
      <p className="flex items-center gap-1 text-[11px] text-slate-500"><FileText size={11} aria-hidden="true" /> The model reads these under the server's heading, after what the server says about itself.</p>
    </div>
  )
}
