import { Fragment, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Plus, Search, type LucideIcon } from 'lucide-react'

export interface ExplorerLink {
  to: string
  params?: Record<string, string> | undefined
}

export interface ExplorerFile {
  id: string
  title: string
  icon: LucideIcon
  link: ExplorerLink
  startsGroup?: boolean | undefined
  badge?: ReactNode
}

export interface ExplorerItem {
  id: string
  label: string
  icon: LucideIcon
  link: ExplorerLink
  mono?: boolean | undefined
  mine?: boolean | undefined
  files: readonly ExplorerFile[]
}

export interface ExplorerGroup {
  id: string
  title: string
  items: readonly ExplorerItem[]
}

export interface PathStep {
  label: string
  link?: ExplorerLink | undefined
}

const row = 'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs'

export default function Explorer({ title, groups, selected, path, onNew, newPlaceholder, loading, error, fill = false, children }: {
  title: string
  groups: readonly ExplorerGroup[]
  selected?: { item: string; file?: string | undefined } | undefined
  path: readonly PathStep[]
  onNew?: ((name: string) => void) | undefined
  newPlaceholder?: string | undefined
  loading?: boolean | undefined
  error?: string | undefined
  fill?: boolean | undefined
  children: ReactNode
}) {
  const [filter, setFilter] = useState('')
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(new Set())
  const [openItems, setOpenItems] = useState<ReadonlySet<string>>(() => new Set(selected ? [selected.item] : []))
  const [naming, setNaming] = useState<string | null>(null)
  const [seen, setSeen] = useState(selected?.item)
  if (selected?.item !== seen) {
    setSeen(selected?.item)
    if (selected && !openItems.has(selected.item)) setOpenItems(new Set([...openItems, selected.item]))
  }

  const wanted = filter.trim().toLowerCase()
  const shown = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !wanted || item.id.toLowerCase().includes(wanted) || item.label.toLowerCase().includes(wanted)) }))
    .filter((group) => group.items.length > 0)

  const toggle = (set: ReadonlySet<string>, value: string): Set<string> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  const create = () => {
    const name = (naming ?? '').trim()
    if (!name || !onNew) return
    setNaming(null)
    onNew(name)
  }

  return (
    <div className="flex h-full min-h-0">
      <aside aria-label={title} className="flex w-72 shrink-0 flex-col border-r border-[var(--bark-700)] bg-[var(--bark-900)]/50">
        <div className="flex items-center gap-2 px-3 pb-2 pt-4">
          <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</span>
          {onNew && (
            <button type="button" aria-label={`New ${title.toLowerCase().replace(/s$/, '')}`} title="New" onClick={() => setNaming('')} className="rounded p-1 text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-100">
              <Plus size={14} />
            </button>
          )}
        </div>
        <label className="mx-3 mb-2 flex items-center gap-1.5 rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1">
          <Search size={12} className="text-slate-500" />
          <input aria-label={`Find in ${title.toLowerCase()}`} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find" className="w-full bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600" />
        </label>
        {naming !== null && (
          <input
            autoFocus
            aria-label={`Name of the new ${title.toLowerCase().replace(/s$/, '')}`}
            value={naming}
            onChange={(event) => setNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') create()
              if (event.key === 'Escape') setNaming(null)
            }}
            placeholder={newPlaceholder ?? 'Its name, then Enter'}
            className="mx-3 mb-2 rounded border border-[var(--leaf-stem)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none"
          />
        )}

        <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
          {loading && <p className="px-2 text-xs text-slate-500">Loading…</p>}
          {error && <p className="px-2 text-xs text-red-300">{error}</p>}
          {shown.map((group) => {
            const closed = closedGroups.has(group.id)
            return (
              <div key={group.id} className="mt-1">
                <button type="button" onClick={() => setClosedGroups((current) => toggle(current, group.id))} className={`${row} text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300`}>
                  {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />} {group.title}
                  <span className="ml-auto font-normal text-slate-600">{group.items.length}</span>
                </button>
                {!closed && group.items.map((item) => {
                  const open = openItems.has(item.id)
                  const active = selected?.item === item.id
                  return (
                    <div key={item.id}>
                      <div className={`${row} ${active && !selected?.file ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-300 hover:bg-[var(--bark-800)]'}`}>
                        <button type="button" aria-label={open ? `Close ${item.id}` : `Open ${item.id}`} onClick={() => setOpenItems((current) => toggle(current, item.id))} className="text-slate-500 hover:text-slate-200">
                          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </button>
                        <Link to={item.link.to} params={item.link.params ?? {}} onClick={() => setOpenItems((current) => new Set([...current, item.id]))} className="flex min-w-0 flex-1 items-center gap-1.5">
                          <item.icon size={13} className="shrink-0 text-[var(--leaf)]" />
                          <span className={`truncate ${item.mono ? 'font-mono' : ''}`}>{item.label}</span>
                          {item.mine && <span className="text-[9px] text-[var(--leaf-light)]">yours</span>}
                        </Link>
                      </div>
                      {open && (
                        <ul className="ml-4 border-l border-[var(--bark-700)] pl-1">
                          {item.files.map((file) => (
                            <li key={file.id} className={file.startsGroup ? 'mt-1 border-t border-[var(--bark-800)] pt-1' : ''}>
                              <Link
                                to={file.link.to}
                                params={file.link.params ?? {}}
                                className={`${row} ${active && selected?.file === file.id ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-800)] hover:text-slate-200'}`}
                              >
                                <file.icon size={12} className="shrink-0 text-slate-500" /> {file.title}
                                {file.badge}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </nav>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <nav aria-label="Path" className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--bark-700)] px-6 text-xs text-slate-500">
          {path.map((step, index) => (
            <Fragment key={`${step.label}-${index}`}>
              {index > 0 && <ChevronRight size={12} />}
              {step.link && index < path.length - 1
                ? <Link to={step.link.to} params={step.link.params ?? {}} className="hover:text-slate-200">{step.label}</Link>
                : <span className={index === path.length - 1 ? 'text-slate-200' : ''}>{step.label}</span>}
            </Fragment>
          ))}
        </nav>
        {fill ? (
          <div className="min-h-0 flex-1">{children}</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto w-full max-w-5xl">{children}</div>
          </div>
        )}
      </section>
    </div>
  )
}

export function FileHeader({ title, says }: { title: string; says?: string | undefined }) {
  return (
    <header className="mb-4">
      <h1 className="text-lg font-semibold text-slate-100">{title}</h1>
      {says && <p className="text-xs text-slate-500">{says}</p>}
    </header>
  )
}
