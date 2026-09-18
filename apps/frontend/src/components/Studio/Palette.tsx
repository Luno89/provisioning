import { useMemo, useState } from 'react'
import { Layers, Search } from 'lucide-react'
import { GROUP_KIND, NODE_CATEGORIES, type NodeCategory } from '@koala/agent-engine/procedure'
import type { Procedure } from '@koala/agent-engine/procedure'
import { libraryOf, type GroupPath } from '../../lib/procedure-canvas'
import { CATEGORY_COLOURS, CATEGORY_TITLES, NODE_DRAG_TYPE, STUDIO_CONTEXT } from './shared'

interface PaletteItem {
  key: string
  kind: string
  group?: string
  title: string
  describe: string
  category: NodeCategory
  isValue: boolean
}

export interface PaletteProps {
  procedure: Procedure
  path: GroupPath
  editable: boolean
  onAdd: (kind: string, group?: string) => void
}

export default function Palette({ procedure, path, editable, onAdd }: PaletteProps) {
  const [search, setSearch] = useState('')

  const items = useMemo<PaletteItem[]>(() => {
    const nodes = STUDIO_CONTEXT.catalogue.list().map((definition) => ({
      key: definition.kind,
      kind: definition.kind,
      title: definition.title,
      describe: definition.describe,
      category: definition.category,
      isValue: definition.role === 'value',
    }))
    const groups = [...libraryOf(procedure, STUDIO_CONTEXT).values()]
      .filter((group) => !path.includes(group.id))
      .map((group) => ({
        key: `group:${group.id}`,
        kind: GROUP_KIND,
        group: group.id,
        title: group.title,
        describe: group.describe,
        category: 'custom' as const,
        isValue: false,
      }))
    return [...nodes, ...groups]
  }, [procedure, path])

  const needle = search.trim().toLowerCase()
  const shown = needle
    ? items.filter((item) => `${item.title} ${item.kind} ${item.group ?? ''} ${item.describe}`.toLowerCase().includes(needle))
    : items

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-[var(--bark-700)] bg-[var(--bark-900)]">
      <div className="border-b border-[var(--bark-700)] p-2">
        <label className="flex items-center gap-1.5 rounded-md border border-[var(--bark-700)] bg-[var(--bark-800)] px-2 py-1.5">
          <Search size={12} className="text-slate-500" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a node"
            aria-label="Find a node"
            className="w-full bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-500"
          />
        </label>
        <p className="mt-1.5 px-0.5 text-[10px] leading-snug text-slate-500">
          {editable ? 'Drag a node onto the canvas, or click to add it.' : 'This is a built-in group, so nothing can be added here.'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {NODE_CATEGORIES.map((category) => {
          const inCategory = shown.filter((item) => item.category === category)
          if (inCategory.length === 0) return null
          return (
            <section key={category} className="mb-3">
              <h3 className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                <span className="h-2 w-2 rounded-full" style={{ background: CATEGORY_COLOURS[category] }} />
                {CATEGORY_TITLES[category]}
              </h3>
              {inCategory.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  draggable={editable}
                  disabled={!editable}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(NODE_DRAG_TYPE, JSON.stringify({ kind: item.kind, ...(item.group ? { group: item.group } : {}) }))
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => onAdd(item.kind, item.group)}
                  title={item.describe}
                  className="group mb-0.5 w-full cursor-grab rounded-md px-2 py-1.5 text-left hover:bg-[var(--bark-800)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex items-center gap-1.5 text-xs text-slate-200">
                    {item.group && <Layers size={11} className="text-fuchsia-300" />}
                    <span className="truncate">{item.title}</span>
                    {item.isValue && <span className="ml-auto rounded border border-dashed border-slate-600 px-1 text-[9px] text-slate-400">value</span>}
                  </div>
                  <p className="line-clamp-2 text-[10px] leading-snug text-slate-500 group-hover:text-slate-400">{item.describe}</p>
                </button>
              ))}
            </section>
          )
        })}
        {shown.length === 0 && <p className="px-1 text-xs text-slate-500">No node matches “{search}”.</p>}
      </div>
    </aside>
  )
}
