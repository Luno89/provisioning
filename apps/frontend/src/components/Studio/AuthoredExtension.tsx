import { useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import type { ExtensionSummary } from '../../api/engine'
import { publishedName } from '../../lib/published-groups'
import { useAgents, useDeleteExtension, useEngineTools, useProcedureList, useRemoveOperation, useUpdateExtension } from './shared'

const chip = 'flex items-center gap-1 rounded border border-[var(--bark-600)] px-1.5 py-0.5 text-[11px]'

interface Choices {
  label: string
  field: 'personas' | 'tools' | 'procedures'
  mine: string[]
}

export interface AuthoredExtensionProps {
  extension: ExtensionSummary
  onRefused: (message: string) => void
}

export default function AuthoredExtension({ extension, onRefused }: AuthoredExtensionProps) {
  const agents = useAgents()
  const tools = useEngineTools()
  const procedures = useProcedureList()
  const update = useUpdateExtension(onRefused)
  const removeOne = useRemoveOperation(onRefused)
  const remove = useDeleteExtension(onRefused)
  const [confirming, setConfirming] = useState(false)

  const latest = (extension.latest ?? []).map((id) => ({ id, name: publishedName(id), group: extension.groups.find((group) => group.id === id) }))
  const choices: Choices[] = [
    { label: 'Agents', field: 'personas', mine: (agents.data ?? []).filter((agent) => agent.ownerId).map((agent) => agent.slug) },
    { label: 'Tools', field: 'tools', mine: (tools.data ?? []).filter((tool) => tool.ownerId).map((tool) => tool.name) },
    { label: 'Procedures', field: 'procedures', mine: (procedures.data?.procedures ?? []).filter((procedure) => procedure.mine && !procedure.ofBuiltIn).map((procedure) => procedure.id) },
  ]

  const toggle = (field: Choices['field'], item: string, on: boolean) => {
    const current = extension[field]
    update.mutate({ id: extension.id, bundle: { [field]: on ? [...current, item] : current.filter((entry) => entry !== item) } })
  }

  return (
    <div className="mt-3 space-y-3 border-t border-[var(--bark-700)] pt-3">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Operations</p>
        {latest.length === 0 && <p className="mt-1 text-[11px] text-slate-500">None yet. Open a group in a procedure and use Publish as operation.</p>}
        <ul className="mt-1 space-y-1">
          {latest.map(({ id, name, group }) => (
            <li key={id} className="flex items-center gap-2 text-[11px] text-slate-300">
              <span className="truncate">{group?.title ?? id}</span>
              <span className="font-mono text-slate-500">{id}</span>
              {name && name.version > 1 && <span className="text-slate-500">· {name.version} versions</span>}
              <button
                type="button"
                aria-label={`Remove ${group?.title ?? id}`}
                className="ml-auto text-slate-500 hover:text-rose-300 disabled:opacity-40"
                disabled={removeOne.isPending || !name}
                onClick={() => name && removeOne.mutate({ extension: extension.id, name: name.name })}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {choices.map(({ label, field, mine }) => (
        <div key={field}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
          {mine.length === 0 && extension[field].length === 0 && <p className="mt-1 text-[11px] text-slate-500">You have none of your own to bundle.</p>}
          <div className="mt-1 flex flex-wrap gap-1">
            {[...new Set([...mine, ...extension[field]])].sort().map((item) => (
              <label key={item} className={`${chip} ${extension[field].includes(item) ? 'border-[var(--leaf-stem)] text-slate-100' : 'text-slate-400'}`}>
                <input
                  type="checkbox"
                  aria-label={`Bundle ${item}`}
                  checked={extension[field].includes(item)}
                  disabled={update.isPending}
                  onChange={(event) => toggle(field, item, event.target.checked)}
                />
                {item}
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2">
        {update.isPending && <Loader2 size={12} className="animate-spin text-slate-400" />}
        {confirming ? (
          <>
            <span className="text-[11px] text-slate-300">Delete {extension.title}? What it bundles stays yours.</span>
            <button type="button" className="text-[11px] text-rose-300 hover:text-rose-200" disabled={remove.isPending} onClick={() => remove.mutate(extension.id, { onSettled: () => setConfirming(false) })}>Delete</button>
            <button type="button" className="text-[11px] text-slate-400 hover:text-slate-200" onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="ml-auto flex items-center gap-1 text-[11px] text-slate-500 hover:text-rose-300" onClick={() => setConfirming(true)}>
            <Trash2 size={12} /> Delete extension
          </button>
        )}
      </div>
    </div>
  )
}
