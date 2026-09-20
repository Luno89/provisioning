import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import type { EngineTool } from '../../api/engineTools'
import ToolEditor from './ToolEditor'
import { errorMessage, useEngineTools } from './shared'
import { blankTool } from './tool-forms'

export default function ToolsView() {
  const tools = useEngineTools()
  const [open, setOpen] = useState<string>()
  const [fresh, setFresh] = useState<EngineTool>()
  const [name, setName] = useState('')

  const editing = fresh ?? tools.data?.find((tool) => tool.name === open)

  const start = () => {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    if (!slug) return
    setOpen(undefined)
    setFresh(blankTool(slug))
    setName('')
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <p className="max-w-2xl text-sm text-slate-400">
          A tool is a command an agent may run in its workspace, plus the arguments it takes and the binary it needs. Saying which binary it needs, and how to install it, is what puts that binary in the workspace image — so changing it rebuilds the workspace of every agent granted it.
        </p>
        <div className="ml-auto flex items-center gap-2">
          <input
            aria-label="Name of the new tool"
            className="w-48 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)]"
            placeholder="New tool's name"
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
            <Plus size={14} /> New tool
          </button>
        </div>
      </div>

      {tools.isPending && <p className="flex items-center gap-1.5 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Loading tools…</p>}
      {tools.isError && <p className="text-xs text-red-300">{errorMessage(tools.error)}</p>}

      {editing && (
        <ToolEditor
          key={editing.name}
          tool={editing}
          onClose={() => { setFresh(undefined); setOpen(undefined) }}
        />
      )}

      <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
        {(tools.data ?? []).map((tool) => (
          <li key={tool.name}>
            <button
              type="button"
              onClick={() => { setFresh(undefined); setOpen(tool.name === open ? undefined : tool.name) }}
              className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bark-800)]/40"
            >
              <span className="font-mono text-sm text-slate-200">{tool.name}</span>
              <span className="rounded border border-[var(--bark-600)] px-1 text-[10px] text-slate-400">
                {tool.mine ? 'yours' : 'built-in'}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{tool.summary}</span>
              {tool.command && <span className="shrink-0 truncate font-mono text-[11px] text-slate-500">{tool.command}</span>}
              {(tool.needsBinaries ?? []).length > 0 && (
                <span className="shrink-0 text-[11px] text-emerald-300">needs {(tool.needsBinaries ?? []).join(', ')}</span>
              )}
              <span className="shrink-0 text-[11px] text-slate-500">
                {tool.grantedTo.length === 0 ? 'granted to nobody' : `granted to ${tool.grantedTo.join(', ')}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
