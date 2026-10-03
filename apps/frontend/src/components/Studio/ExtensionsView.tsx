import { useState } from 'react'
import type { ExtensionSummary } from '../../api/engine'
import { Loader2, Plus } from 'lucide-react'
import { errorMessage, useCreateExtension, useExtensions, useSwitchExtension } from './shared'
import AuthoredExtension from './AuthoredExtension'

const input = 'rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)]'

const nodesOf = (extension: ExtensionSummary): number => extension.operations.length + (extension.latest ?? []).length

export default function ExtensionsView() {
  const extensions = useExtensions()
  const [refused, setRefused] = useState<string>()
  const toggle = useSwitchExtension(setRefused)
  const create = useCreateExtension(setRefused)
  const [fresh, setFresh] = useState({ id: '', title: '', describe: '' })

  if (extensions.isPending) return <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading extensions…</p>
  if (extensions.isError) return <p className="text-sm text-rose-400">{errorMessage(extensions.error)}</p>

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-slate-400">
        An extension brings nodes, agents, tools and procedures to the engine. Switching one off takes all of it out of your palette, your chats and your runs; a procedure that uses it stops saving until it is back on. Nothing you made is deleted.
      </p>
      <form
        className="flex max-w-2xl flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          setRefused(undefined)
          create.mutate({ id: fresh.id.trim(), title: fresh.title.trim(), describe: fresh.describe.trim() }, { onSuccess: () => setFresh({ id: '', title: '', describe: '' }) })
        }}
      >
        <input aria-label="New extension's id" placeholder="id, e.g. my-tools" className={`${input} w-36 font-mono`} value={fresh.id} onChange={(event) => setFresh({ ...fresh, id: event.target.value })} />
        <input aria-label="New extension's title" placeholder="Title" className={`${input} w-40`} value={fresh.title} onChange={(event) => setFresh({ ...fresh, title: event.target.value })} />
        <input aria-label="What the new extension does" placeholder="What it does" className={`${input} min-w-48 flex-1`} value={fresh.describe} onChange={(event) => setFresh({ ...fresh, describe: event.target.value })} />
        <button type="submit" disabled={create.isPending || !fresh.id.trim() || !fresh.title.trim()} className="flex items-center gap-1 rounded-md bg-[var(--leaf-stem)] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40">
          {create.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} New extension
        </button>
      </form>
      {refused && <p role="alert" className="text-sm text-rose-400">{refused}</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {extensions.data.map((extension) => (
          <li key={extension.id} className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)] p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-100">{extension.title}</p>
                <p className="mt-0.5 font-mono text-[10px] text-slate-500">{extension.id} · v{extension.version}{extension.authored ? ' · yours' : ''}{extension.requires.length > 0 ? ` · needs ${extension.requires.join(', ')}` : ''}</p>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  aria-label={`${extension.title} is on`}
                  checked={extension.enabled}
                  disabled={extension.alwaysOn || toggle.isPending}
                  onChange={(event) => { setRefused(undefined); toggle.mutate({ id: extension.id, enabled: event.target.checked }) }}
                />
                {extension.alwaysOn ? 'always on' : extension.enabled ? 'on' : 'off'}
              </label>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">{extension.describe}</p>
            <p className="mt-2 text-[11px] text-slate-500">
              {nodesOf(extension)} node{nodesOf(extension) === 1 ? '' : 's'} · {extension.personas.length} agent{extension.personas.length === 1 ? '' : 's'} · {extension.tools.length} tool{extension.tools.length === 1 ? '' : 's'} · {extension.procedures.length} procedure{extension.procedures.length === 1 ? '' : 's'}
            </p>
            {extension.authored && <AuthoredExtension extension={extension} onRefused={setRefused} />}
          </li>
        ))}
      </ul>
    </div>
  )
}
