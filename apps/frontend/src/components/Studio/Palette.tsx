import { useMemo, useState } from 'react'
import { Layers, Search } from 'lucide-react'
import { GROUP_KIND, HOST_OP_KIND, NODE_CATEGORIES, type NodeCategory } from '@koala/agent-engine/procedure'
import type { Procedure } from '@koala/agent-engine/procedure'
import { libraryOf, type GroupPath } from '../../lib/procedure-canvas'
import { publishedName } from '../../lib/published-groups'
import { CATEGORY_COLOURS, CATEGORY_TITLES, NODE_DRAG_TYPE, useStudioContext } from './shared'

interface PaletteItem {
  key: string
  kind: string
  group?: string
  operation?: string
  section?: string
  title: string
  describe: string
  category: NodeCategory
  isValue: boolean
}

export interface PaletteProps {
  procedure: Procedure
  path: GroupPath
  editable: boolean
  onAdd: (kind: string, group?: string, operation?: string) => void
}

export default function Palette({ procedure, path, editable, onAdd }: PaletteProps) {
  const context = useStudioContext()
  const [search, setSearch] = useState('')

  const items = useMemo<PaletteItem[]>(() => {
    const operations = (context.operations ?? []).map((operation) => ({
      key: `operation:${operation.name}`,
      kind: HOST_OP_KIND,
      operation: operation.name,
      section: context.extensions?.find((extension) => operation.name.startsWith(`${extension.id}.`))?.title ?? operation.group,
      title: operation.title,
      describe: operation.describe,
      category: 'host' as const,
      isValue: false,
    }))
    const nodes = context.catalogue.list().filter((definition) => definition.kind !== HOST_OP_KIND).map((definition) => ({
      key: definition.kind,
      kind: definition.kind,
      title: definition.title,
      describe: definition.describe,
      category: definition.category,
      isValue: definition.role === 'value',
    }))
    const groups = [...libraryOf(procedure, context).values()]
      .filter((group) => !path.includes(group.id) && !context.retired?.has(group.id))
      .map((group) => ({
        key: `group:${group.id}`,
        kind: GROUP_KIND,
        group: group.id,
        section: context.extensions?.find((extension) => group.id.startsWith(`${extension.id}.`))?.title,
        title: group.title,
        describe: group.describe,
        category: 'custom' as const,
        isValue: false,
      }))
    return [...nodes, ...operations, ...groups]
  }, [procedure, path, context])

  const needle = search.trim().toLowerCase()
  const shown = needle
    ? items.filter((item) => `${item.title} ${item.kind} ${item.group ?? ''} ${item.operation ?? ''} ${item.section ?? ''} ${item.describe}`.toLowerCase().includes(needle))
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
          {editable ? 'Drag a node onto the canvas, or click to add it.' : publishedName(path[path.length - 1] ?? '') ? 'This is a published version, so nothing can be added here — edit a new version instead.' : 'This is a built-in group, so nothing can be added here.'}
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
              {inCategory.map((item, index) => (
                <div key={item.key}>
                {item.section && item.section !== inCategory[index - 1]?.section && (
                  <h4 className="mt-1.5 mb-0.5 px-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">{item.section}</h4>
                )}
                <button
                  type="button"
                  draggable={editable}
                  disabled={!editable}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(NODE_DRAG_TYPE, JSON.stringify({ kind: item.kind, ...(item.group ? { group: item.group } : {}), ...(item.operation ? { operation: item.operation } : {}) }))
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => onAdd(item.kind, item.group, item.operation)}
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
                </div>
              ))}
            </section>
          )
        })}
        {shown.length === 0 && <p className="px-1 text-xs text-slate-500">No node matches “{search}”.</p>}
      </div>
    </aside>
  )
}
