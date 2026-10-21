import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ArrowDownUp, ChevronDown, ChevronRight, Download, File, Folder, FolderPlus, Loader2, Pencil, Search, Trash2, Upload, X } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { storedFileUrl } from '../../api/files'
import { joinPath, pickedFiles, sizeText, type PickedFile } from '../../lib/file-drop'
import { MOVE_TYPE, moveInto, parentOf, sortEntries, type SortBy } from '../../lib/file-browser'
import type { FileScope, StoredFile } from '../../types/files'
import DropTarget from './DropTarget'
import StoredFilePreview from './StoredFilePreview'
import { useStoredChanges, useStoredFiles, useStoredSearch, useStoredUpload } from './shared'

const row = 'group flex items-center gap-1 rounded px-1 py-0.5 text-[12px]'
const tool = 'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-200 disabled:opacity-50'

interface Browsing {
  scope: FileScope
  sort: { by: SortBy; descending: boolean }
  selected: ReadonlySet<string>
  toggle: (path: string) => void
  open: (path: string) => void
  add: (dir: string, picked: PickedFile[]) => void
  moveTo: (paths: readonly string[], folder: string) => void
}

const draggedPaths = (event: DragEvent): string[] => {
  const raw = event.dataTransfer.getData(MOVE_TYPE)
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

const takesMoves = (folder: string, onMove: (paths: string[], folder: string) => void) => ({
  onDragOver: (event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes(MOVE_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  },
  onDrop: (event: DragEvent) => {
    const paths = draggedPaths(event)
    if (!paths.length) return
    event.preventDefault()
    event.stopPropagation()
    onMove(paths, folder)
  },
})

function Entry({ entry, depth, browsing, flat = false }: { entry: StoredFile; depth: number; browsing: Browsing; flat?: boolean }) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | undefined>()
  const [removing, setRemoving] = useState(false)
  const { remove, move } = useStoredChanges(browsing.scope)
  const chosen = browsing.selected.has(entry.path)

  const dragging = {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      const paths = chosen ? [...browsing.selected] : [entry.path]
      event.dataTransfer.setData(MOVE_TYPE, JSON.stringify(paths))
      event.dataTransfer.effectAllowed = 'move'
    },
  }

  const actions = (
    <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
      {entry.type === 'file' && <a href={storedFileUrl(browsing.scope, entry.path)} aria-label={`Download ${entry.name}`} title="Download" className="rounded p-0.5 text-slate-500 hover:text-slate-200"><Download size={11} /></a>}
      <button type="button" aria-label={`Rename ${entry.name}`} title="Rename" onClick={() => setRenaming(entry.name)} className="rounded p-0.5 text-slate-500 hover:text-slate-200"><Pencil size={11} /></button>
      <button type="button" aria-label={removing ? `Remove ${entry.name} for good` : `Remove ${entry.name}`} title={removing ? 'Click again to remove it for good' : 'Remove'} onClick={() => (removing ? remove.mutate(entry.path) : setRemoving(true))} onMouseLeave={() => setRemoving(false)} className={`rounded p-0.5 ${removing ? 'text-red-300' : 'text-slate-500 hover:text-red-300'}`}><Trash2 size={11} /></button>
    </span>
  )

  const label = renaming !== undefined ? (
    <input
      autoFocus
      aria-label={`New name for ${entry.name}`}
      value={renaming}
      onChange={(event) => setRenaming(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setRenaming(undefined)
        if (event.key === 'Enter' && renaming.trim() && renaming.trim() !== entry.name) { move.mutate({ from: entry.path, to: joinPath(parentOf(entry.path), renaming.trim()) }); setRenaming(undefined) }
      }}
      onBlur={() => setRenaming(undefined)}
      className="min-w-0 flex-1 rounded border border-[var(--leaf-stem)] bg-[var(--bark-900)] px-1 text-[12px] text-slate-200 outline-none"
    />
  ) : entry.type === 'file'
    ? <button type="button" onClick={() => browsing.open(entry.path)} aria-label={`Open ${flat ? entry.path : entry.name}`} className="min-w-0 truncate text-left hover:underline">{flat ? entry.path : entry.name}</button>
    : <span className="truncate">{entry.name}</span>

  const check = <input type="checkbox" aria-label={`Select ${entry.name}`} checked={chosen} onChange={() => browsing.toggle(entry.path)} className="shrink-0 accent-[var(--leaf)] opacity-40 group-hover:opacity-100 checked:opacity-100" />

  if (entry.type === 'file') {
    return (
      <div className={`${row} ${chosen ? 'bg-[var(--bark-700)]/60' : ''} text-slate-300 hover:bg-[var(--bark-700)]`} style={{ paddingLeft: depth * 12 + 2 }} {...dragging}>
        {check}
        <File size={12} className="shrink-0 text-slate-500" />
        {label}
        <span className="shrink-0 text-[10px] text-slate-600">{sizeText(entry.size)}</span>
        {actions}
      </div>
    )
  }
  return (
    <DropTarget label={`Drop to add to ${entry.path}`} onFiles={(picked) => browsing.add(entry.path, picked)}>
      <div className={`${row} ${chosen ? 'bg-[var(--bark-700)]/60' : ''} text-slate-300 hover:bg-[var(--bark-700)]`} style={{ paddingLeft: depth * 12 + 2 }} {...dragging} {...takesMoves(entry.path, browsing.moveTo)}>
        {check}
        <button type="button" onClick={() => setOpen((was) => !was)} aria-label={open ? `Close ${entry.name}` : `Open ${entry.name}`} className="flex shrink-0 items-center text-slate-500">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <Folder size={12} className="shrink-0 text-amber-300" />
        {label}
        {actions}
      </div>
      {open && <FolderList dir={entry.path} depth={depth + 1} browsing={browsing} />}
    </DropTarget>
  )
}

function FolderList({ dir, depth, browsing }: { dir: string; depth: number; browsing: Browsing }) {
  const listed = useStoredFiles(browsing.scope, dir)
  const pad = { paddingLeft: depth * 12 + 14 }
  if (listed.isPending) return <p className="text-[11px] text-slate-500" style={pad}><Loader2 size={11} className="inline animate-spin" /> Loading…</p>
  if (listed.isError) return <p className="text-[11px] text-red-300" style={pad}>{errorMessage(listed.error)}</p>
  if (!listed.data.length) return <p className="text-[11px] italic text-slate-600" style={pad}>{depth === 0 ? 'Nothing here yet. Drop files here, or upload them.' : 'Empty'}</p>
  return <>{sortEntries(listed.data, browsing.sort.by, browsing.sort.descending).map((entry) => <Entry key={entry.path} entry={entry} depth={depth} browsing={browsing} />)}</>
}

function Found({ query, browsing }: { query: string; browsing: Browsing }) {
  const found = useStoredSearch(browsing.scope, query)
  if (found.isPending) return <p className="text-[11px] text-slate-500"><Loader2 size={11} className="inline animate-spin" /> Looking…</p>
  if (found.isError) return <p className="text-[11px] text-red-300">{errorMessage(found.error)}</p>
  if (!found.data.length) return <p className="text-[11px] italic text-slate-600">No file is called anything like “{query}”.</p>
  return <>{sortEntries(found.data, browsing.sort.by, browsing.sort.descending).map((entry) => <Entry key={entry.path} entry={entry} depth={0} browsing={browsing} flat />)}</>
}

export default function StoredFiles({ scope, dir = '', title = 'Files', waiting, onTaken, onOpen }: {
  scope: FileScope
  dir?: string | undefined
  title?: string | undefined
  waiting?: { dir: string; picked: PickedFile[] } | undefined
  onTaken?: (() => void) | undefined
  onOpen?: ((path: string) => void) | undefined
}) {
  const { upload, progress } = useStoredUpload(scope)
  const changes = useStoredChanges(scope)
  const picker = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ by: SortBy; descending: boolean }>({ by: 'name', descending: false })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [naming, setNaming] = useState<string | undefined>()
  const [moving, setMoving] = useState<string | undefined>()
  const [removing, setRemoving] = useState(false)
  const [previewing, setPreviewing] = useState<string | undefined>()
  const { mutate } = upload

  useEffect(() => {
    if (!waiting) return
    mutate(waiting)
    onTaken?.()
  }, [waiting, mutate, onTaken])

  const moveTo = (paths: readonly string[], folder: string) => {
    const moves = paths.flatMap((from) => {
      const to = moveInto(from, folder)
      return to ? [{ from, to }] : []
    })
    if (moves.length) changes.moveMany.mutate(moves, { onSuccess: () => setSelected(new Set()) })
  }

  const browsing: Browsing = {
    scope,
    sort,
    selected,
    toggle: (path) => setSelected((was) => { const next = new Set(was); if (next.has(path)) next.delete(path); else next.add(path); return next }),
    open: (path) => (onOpen ? onOpen(path) : setPreviewing(path)),
    add: (into, picked) => upload.mutate({ dir: into, picked }),
    moveTo,
  }
  const failure = upload.error ?? changes.moveMany.error ?? changes.removeMany.error ?? changes.makeFolder.error

  return (
    <DropTarget label={`Drop to add to ${title}`} onFiles={(picked) => browsing.add(dir, picked)} className="min-h-[60px]">
      <div className="mb-1 flex flex-wrap items-center gap-1" {...takesMoves(dir, moveTo)}>
        <span className="mr-auto text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</span>
        <button type="button" onClick={() => setNaming('')} aria-label="New folder" className={tool}><FolderPlus size={11} /> Folder</button>
        <button type="button" onClick={() => picker.current?.click()} disabled={upload.isPending} className={tool}><Upload size={11} /> Upload</button>
        <input ref={picker} type="file" multiple hidden aria-label={`Upload to ${title}`} onChange={(event) => { const picked = pickedFiles(event.target.files); event.target.value = ''; if (picked.length) browsing.add(dir, picked) }} />
      </div>
      <div className="mb-1 flex items-center gap-1">
        <label className="flex min-w-0 flex-1 items-center gap-1 rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-1.5 py-0.5">
          <Search size={11} className="shrink-0 text-slate-500" />
          <input aria-label={`Find in ${title}`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find by name" className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-200 outline-none placeholder:text-slate-600" />
          {query && <button type="button" aria-label="Clear the search" onClick={() => setQuery('')} className="text-slate-500 hover:text-slate-200"><X size={11} /></button>}
        </label>
        <select aria-label="Sort by" value={sort.by} onChange={(event) => setSort({ ...sort, by: event.target.value as SortBy })} className="rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-1 py-0.5 text-[11px] text-slate-300">
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="modified">Date</option>
        </select>
        <button type="button" aria-label={sort.descending ? 'Sort ascending' : 'Sort descending'} onClick={() => setSort({ ...sort, descending: !sort.descending })} className={tool}><ArrowDownUp size={11} /></button>
      </div>
      {naming !== undefined && (
        <input
          autoFocus
          aria-label="Name of the new folder"
          value={naming}
          onChange={(event) => setNaming(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setNaming(undefined)
            if (event.key === 'Enter' && naming.trim()) { changes.makeFolder.mutate(joinPath(dir, naming.trim())); setNaming(undefined) }
          }}
          onBlur={() => setNaming(undefined)}
          placeholder="Folder name, then Enter"
          className="mb-1 w-full rounded border border-[var(--leaf-stem)] bg-[var(--bark-900)] px-1.5 py-0.5 text-[12px] text-slate-200 outline-none"
        />
      )}
      {selected.size > 0 && (
        <div className="mb-1 flex flex-wrap items-center gap-1.5 rounded bg-[var(--bark-800)] px-1.5 py-1 text-[11px] text-slate-300" data-testid="selection">
          <span>{selected.size} selected</span>
          {moving === undefined
            ? <button type="button" onClick={() => setMoving('')} className={tool}>Move to…</button>
            : (
              <input
                autoFocus
                aria-label="Folder to move them to"
                value={moving}
                onChange={(event) => setMoving(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setMoving(undefined)
                  if (event.key === 'Enter') { moveTo([...selected], joinPath(moving)); setMoving(undefined) }
                }}
                placeholder="folder path, empty for the top, then Enter"
                className="min-w-0 flex-1 rounded border border-[var(--leaf-stem)] bg-[var(--bark-900)] px-1 py-0.5 text-[11px] text-slate-200 outline-none"
              />
            )}
          <button
            type="button"
            onClick={() => (removing ? changes.removeMany.mutate([...selected], { onSuccess: () => { setSelected(new Set()); setRemoving(false) } }) : setRemoving(true))}
            onMouseLeave={() => setRemoving(false)}
            className={`${tool} ${removing ? 'text-red-300' : ''}`}
          >
            <Trash2 size={11} /> {removing ? 'Remove them for good' : 'Remove'}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className={`${tool} ml-auto`}>Clear</button>
        </div>
      )}
      {progress && <p className="text-[11px] text-sky-300">Uploading {progress.current} ({progress.done + 1} of {progress.total}, {Math.round(progress.share * 100)}%)</p>}
      {(changes.moveMany.isPending || changes.removeMany.isPending) && <p className="text-[11px] text-sky-300"><Loader2 size={11} className="inline animate-spin" /> Working…</p>}
      {failure && <p role="alert" className="text-[11px] text-red-300">{errorMessage(failure)}</p>}
      {query.trim() ? <Found query={query} browsing={browsing} /> : <FolderList dir={dir} depth={0} browsing={browsing} />}
      {previewing && (
        <div role="dialog" aria-label={`Preview of ${previewing}`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setPreviewing(undefined)}>
          <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)]" onClick={(event) => event.stopPropagation()}>
            <StoredFilePreview scope={scope} path={previewing} onClose={() => setPreviewing(undefined)} />
          </div>
        </div>
      )}
    </DropTarget>
  )
}
