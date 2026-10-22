import { useState } from 'react'
import { Loader2, PackagePlus } from 'lucide-react'
import type { GroupDefinition, Procedure } from '@koala/agent-engine/procedure'
import { adoptPublished, draftOf, operationName } from '../../lib/published-groups'
import { errorMessage, useCreateExtension, useExtensions, usePublishOperation } from './shared'

const input = 'w-full rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)] disabled:opacity-60'
const NEW = '__new__'

export interface PublishGroupProps {
  procedure: Procedure
  group: GroupDefinition
  onChange: (next: Procedure) => void
  onShowGroup: (groupId: string) => void
  onAnnounce: (message: string) => void
}

export default function PublishGroup({ procedure, group, onChange, onShowGroup, onAnnounce }: PublishGroupProps) {
  const extensions = useExtensions()
  const create = useCreateExtension()
  const publish = usePublishOperation()
  const authored = (extensions.data ?? []).filter((extension) => extension.authored)
  const drafted = draftOf(group.id)

  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<string>()
  const [fresh, setFresh] = useState({ id: '', title: '' })
  const [name, setName] = useState(drafted?.name ?? operationName(group.title))
  const [adopt, setAdopt] = useState(true)
  const [said, setSaid] = useState<{ tone: 'ok' | 'refused'; text: string }>()

  const target = chosen ?? (drafted && authored.some((extension) => extension.id === drafted.extension) ? drafted.extension : authored[0]?.id ?? NEW)
  const busy = create.isPending || publish.isPending

  const submit = async () => {
    setSaid(undefined)
    try {
      const extension = target === NEW ? fresh.id.trim() : target
      if (target === NEW) await create.mutateAsync({ id: extension, title: fresh.title.trim() })
      const result = await publish.mutateAsync({ extension, name: name.trim(), group })
      const moved = result.moved.length > 0 ? ` ${result.moved.join(', ')} moved onto it.` : ''
      if (!adopt) return setSaid({ tone: 'ok', text: `Published as ${result.id}.${moved}` })
      onChange(adoptPublished(procedure, group.id, result.id))
      onShowGroup(result.id)
      onAnnounce(`Published as ${result.id}.${moved} This procedure uses it now — save to keep that.`)
    } catch (err) {
      setSaid({ tone: 'refused', text: errorMessage(err) })
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-[var(--bark-600)] px-2 py-1 text-[11px] text-slate-300 hover:bg-[var(--bark-700)]"
        title="Make this group a node every procedure of yours can use, versioned"
      >
        <PackagePlus size={12} /> {drafted ? 'Publish this version' : 'Publish as operation'}
      </button>
    )
  }

  return (
    <div className="space-y-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-800)] p-2">
      <label className="block text-[11px] text-slate-400">
        Extension
        <select aria-label="Extension to publish into" className={`${input} mt-0.5`} value={target} disabled={busy} onChange={(event) => setChosen(event.target.value)}>
          {authored.map((extension) => <option key={extension.id} value={extension.id}>{extension.title}</option>)}
          <option value={NEW}>New extension…</option>
        </select>
      </label>
      {target === NEW && (
        <div className="grid grid-cols-2 gap-1.5">
          <input aria-label="New extension's id" placeholder="id, e.g. my-tools" className={input} value={fresh.id} disabled={busy} onChange={(event) => setFresh({ ...fresh, id: event.target.value })} />
          <input aria-label="New extension's title" placeholder="Title" className={input} value={fresh.title} disabled={busy} onChange={(event) => setFresh({ ...fresh, title: event.target.value })} />
        </div>
      )}
      <label className="block text-[11px] text-slate-400">
        Operation name
        <input aria-label="Operation name" className={`${input} mt-0.5 font-mono`} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
        <input type="checkbox" checked={adopt} disabled={busy} onChange={(event) => setAdopt(event.target.checked)} />
        Use it here instead of this copy
      </label>
      <p className="text-[10px] leading-snug text-slate-500">
        Publishing again under the same name makes a new version and moves every procedure of yours onto it — unless that would break one, in which case nothing changes and you are told which.
      </p>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !name.trim() || (target === NEW && (!fresh.id.trim() || !fresh.title.trim()))}
          className="flex items-center gap-1.5 rounded-md bg-[var(--leaf-stem)] px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <PackagePlus size={12} />} Publish
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded-md px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200">Cancel</button>
      </div>
      {said && <p role={said.tone === 'ok' ? 'status' : 'alert'} className={`text-[11px] ${said.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>{said.text}</p>}
    </div>
  )
}
