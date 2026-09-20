import { useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import type { EngineTool, InstallVia, ToolArgument } from '../../api/engineTools'
import { errorMessage, useDeleteEngineTool, useSaveEngineTool } from './shared'
import { commandProblems, packagesOf } from './tool-forms'

const field = 'w-full rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)]'

const label = 'text-[10px] font-semibold uppercase tracking-wider text-slate-400'

const VIA: InstallVia[] = ['base', 'dnf', 'apt', 'pip', 'npm', 'script']

const VIA_SAYS: Record<InstallVia, string> = {
  base: 'nothing to install — the workspace already has it',
  dnf: 'system packages (Red Hat bases)',
  apt: 'system packages (Debian bases)',
  pip: 'python packages',
  npm: 'node packages, installed globally',
  script: 'a command run as root while the image is built',
}

export default function ToolEditor({ tool, onClose }: { tool: EngineTool; onClose: () => void }) {
  const [draft, setDraft] = useState<EngineTool>(tool)
  const [problems, setProblems] = useState<string[]>([])
  const [rebuilding, setRebuilding] = useState<string[]>([])
  const save = useSaveEngineTool((started) => (started.length > 0 ? setRebuilding(started) : onClose()))
  const remove = useDeleteEngineTool(() => onClose())

  const set = <K extends keyof EngineTool>(key: K, value: EngineTool[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const args = Object.entries(draft.parameters.properties)

  const setArgument = (name: string, next: Partial<ToolArgument> & { rename?: string }) => {
    setDraft((current) => {
      const properties: Record<string, ToolArgument> = {}
      for (const [key, schema] of Object.entries(current.parameters.properties)) {
        if (key !== name) { properties[key] = schema; continue }
        properties[next.rename ?? key] = {
          type: next.type ?? schema.type,
          description: next.description ?? schema.description,
        }
      }
      return { ...current, parameters: { ...current.parameters, properties } }
    })
  }

  const addArgument = () => setDraft((current) => ({
    ...current,
    parameters: {
      ...current.parameters,
      properties: { ...current.parameters.properties, [`argument_${Object.keys(current.parameters.properties).length + 1}`]: { type: 'string', description: '' } },
    },
  }))

  const dropArgument = (name: string) => setDraft((current) => {
    const { [name]: _gone, ...rest } = current.parameters.properties
    return { ...current, parameters: { ...current.parameters, properties: rest } }
  })

  const setVia = (via: InstallVia) => {
    if (via === 'base') return set('install', { via })
    if (via === 'script') return set('install', { via, run: draft.install && 'run' in draft.install ? draft.install.run : '' })
    return set('install', { via, packages: draft.install && 'packages' in draft.install ? draft.install.packages : [] })
  }

  const local = commandProblems(draft.command ?? '', args.map(([name]) => name))

  const submit = () => {
    setProblems([])
    setRebuilding([])
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
          {tool.mine ? `Editing ${tool.name}` : `Your own copy of ${tool.name}`}
        </h2>
        {!tool.mine && <span className="text-[11px] text-slate-500">saving makes your copy; the built-in is untouched</span>}
        <button type="button" onClick={onClose} className="ml-auto text-[11px] text-slate-500 hover:text-slate-200">Close</button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={label}>Name the model calls it by</span>
          <input className={`${field} font-mono`} value={draft.name} onChange={(event) => set('name', event.target.value)} />
        </label>
        <label className="space-y-1">
          <span className={label}>What it does</span>
          <input className={field} value={draft.summary} onChange={(event) => set('summary', event.target.value)} />
        </label>
      </div>

      <label className="block space-y-1">
        <span className={label}>Command it runs in the workspace</span>
        <input
          aria-label="Command it runs in the workspace"
          className={`${field} font-mono`}
          value={draft.command ?? ''}
          placeholder="rg --count {pattern} {path}"
          onChange={(event) => set('command', event.target.value)}
        />
        <span className="block text-[11px] text-slate-500">
          Each {'{blank}'} is filled from the arguments below and quoted, so what the model puts in stays one argument and can never become a second command.
        </span>
      </label>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className={label}>Arguments it takes</span>
          <button type="button" onClick={addArgument} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200">
            <Plus size={11} /> Add
          </button>
        </div>
        {args.length === 0 && <p className="text-[11px] text-slate-500">It takes none — the command runs as written.</p>}
        {args.map(([name, schema]) => (
          <div key={name} className="flex flex-wrap items-center gap-2">
            <input
              aria-label={`Name of ${name}`}
              className={`${field} w-40 font-mono`}
              value={name}
              onChange={(event) => setArgument(name, { rename: event.target.value })}
            />
            <select
              aria-label={`Type of ${name}`}
              className={`${field} w-28`}
              value={schema.type}
              onChange={(event) => setArgument(name, { type: event.target.value })}
            >
              {['string', 'number', 'boolean', 'array'].map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <input
              aria-label={`What ${name} is for`}
              className={`${field} min-w-0 flex-1`}
              placeholder="what it is for — the model reads this"
              value={schema.description}
              onChange={(event) => setArgument(name, { description: event.target.value })}
            />
            <button type="button" aria-label={`Remove ${name}`} onClick={() => dropArgument(name)} className="text-slate-500 hover:text-red-300">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={label}>Binaries it needs in the image</span>
          <input
            className={`${field} font-mono`}
            placeholder="rg, jq"
            value={(draft.needsBinaries ?? []).join(', ')}
            onChange={(event) => set('needsBinaries', event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean))}
          />
        </label>
        <label className="space-y-1">
          <span className={label}>How they get installed</span>
          <select className={field} value={draft.install?.via ?? 'base'} onChange={(event) => setVia(event.target.value as InstallVia)}>
            {VIA.map((via) => <option key={via} value={via}>{via} — {VIA_SAYS[via]}</option>)}
          </select>
        </label>
      </div>

      {draft.install && 'packages' in draft.install && (
        <label className="block space-y-1">
          <span className={label}>Packages</span>
          <input
            className={`${field} font-mono`}
            placeholder="ripgrep, jq"
            value={packagesOf(draft.install)}
            onChange={(event) => set('install', {
              via: (draft.install as { via: 'dnf' | 'apt' | 'pip' | 'npm' }).via,
              packages: event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean),
            })}
          />
        </label>
      )}

      {draft.install?.via === 'script' && (
        <label className="block space-y-1">
          <span className={label}>Install script</span>
          <textarea
            className={`${field} font-mono`}
            rows={3}
            placeholder="curl -fsSL https://example.com/tool.sh | sh"
            value={draft.install.run}
            onChange={(event) => set('install', { via: 'script', run: event.target.value })}
          />
          <span className="block text-[11px] text-amber-300">
            This runs as root while the image is built. Only put in what you would run on your own machine.
          </span>
        </label>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={label}>What it gives back</span>
          <input className={field} value={draft.returns} onChange={(event) => set('returns', event.target.value)} />
        </label>
        <label className="space-y-1">
          <span className={label}>What it changes</span>
          <select className={field} value={draft.effect} onChange={(event) => set('effect', event.target.value as EngineTool['effect'])}>
            <option value="read">read — looks at things only</option>
            <option value="write">write — changes things</option>
            <option value="propose">propose — asks for a change</option>
          </select>
        </label>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className={label}>How it fails, in its own words</span>
          <button
            type="button"
            onClick={() => set('failures', [...draft.failures, { when: '', says: '' }])}
            className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
          >
            <Plus size={11} /> Add
          </button>
        </div>
        {draft.failures.map((failure, at) => (
          <div key={at} className="flex flex-wrap items-center gap-2">
            <input
              aria-label={`When it fails ${at + 1}`}
              className={`${field} w-56`}
              placeholder="when the path does not exist"
              value={failure.when}
              onChange={(event) => set('failures', draft.failures.map((one, i) => (i === at ? { ...one, when: event.target.value } : one)))}
            />
            <input
              aria-label={`What it says ${at + 1}`}
              className={`${field} min-w-0 flex-1`}
              placeholder="no such file"
              value={failure.says}
              onChange={(event) => set('failures', draft.failures.map((one, i) => (i === at ? { ...one, says: event.target.value } : one)))}
            />
            <button
              type="button"
              aria-label={`Remove failure ${at + 1}`}
              onClick={() => set('failures', draft.failures.filter((_, i) => i !== at))}
              className="text-slate-500 hover:text-red-300"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      {(local.length > 0 || problems.length > 0) && (
        <ul className="space-y-1 rounded-md border border-red-900 bg-red-950/30 p-2">
          {[...local, ...problems].map((problem) => <li key={problem} className="text-[11px] text-red-300">{problem}</li>)}
        </ul>
      )}

      {rebuilding.length > 0 && (
        <p className="rounded-md border border-amber-900 bg-amber-950/20 p-2 text-[11px] text-amber-300">
          Saved. {rebuilding.join(', ')} {rebuilding.length === 1 ? 'is' : 'are'} rebuilding a workspace to get it.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={save.isPending || local.length > 0}
          className="flex items-center gap-1.5 rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/20 px-3 py-1.5 text-xs font-semibold text-[var(--leaf-light)] hover:bg-[var(--leaf-stem)]/30 disabled:opacity-40"
        >
          {save.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
          {tool.mine ? 'Save' : 'Save as my own'}
        </button>
        {tool.mine && (
          <button
            type="button"
            onClick={() => remove.mutate(draft.name)}
            className="rounded-md border border-red-900 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40"
          >
            Delete my copy
          </button>
        )}
      </div>
    </section>
  )
}
