import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Download, File, Folder, Loader2, Pencil, Trash2, Upload } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { storedFileUrl } from '../../api/files'
import { joinPath, pickedFiles, sizeText, type PickedFile } from '../../lib/file-drop'
import type { FileScope, StoredFile } from '../../types/files'
import DropTarget from './DropTarget'
import { useStoredChanges, useStoredFiles, useStoredUpload } from './shared'

const row = 'group flex items-center gap-1 rounded px-1 py-0.5 text-[12px]'

function Entry({ scope, entry, depth, onDropInto }: { scope: FileScope; entry: StoredFile; depth: number; onDropInto: (dir: string, picked: PickedFile[]) => void }) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | undefined>()
  const [removing, setRemoving] = useState(false)
  const { remove, move } = useStoredChanges(scope)
  const pad = { paddingLeft: depth * 12 }
  const parent = entry.path.split('/').slice(0, -1).join('/')

  const actions = (
    <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
      {entry.type === 'file' && <a href={storedFileUrl(scope, entry.path)} aria-label={`Download ${entry.name}`} title="Download" className="rounded p-0.5 text-slate-500 hover:text-slate-200"><Download size={11} /></a>}
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
        if (event.key === 'Enter' && renaming.trim() && renaming.trim() !== entry.name) { move.mutate({ from: entry.path, to: joinPath(parent, renaming.trim()) }); setRenaming(undefined) }
      }}
      onBlur={() => setRenaming(undefined)}
      className="min-w-0 flex-1 rounded border border-[var(--leaf-stem)] bg-[var(--bark-900)] px-1 text-[12px] text-slate-200 outline-none"
    />
  ) : <span className="truncate">{entry.name}</span>

  if (entry.type === 'file') {
    return (
      <div className={`${row} text-slate-300 hover:bg-[var(--bark-700)]`} style={{ paddingLeft: depth * 12 + 14 }}>
        <File size={12} className="shrink-0 text-slate-500" />
        {label}
        <span className="shrink-0 text-[10px] text-slate-600">{sizeText(entry.size)}</span>
        {actions}
      </div>
    )
  }
  return (
    <DropTarget label={`Drop to add to ${entry.path}`} onFiles={(picked) => onDropInto(entry.path, picked)}>
      <div className={`${row} text-slate-300 hover:bg-[var(--bark-700)]`} style={pad}>
        <button type="button" onClick={() => setOpen((was) => !was)} aria-label={open ? `Close ${entry.name}` : `Open ${entry.name}`} className="flex shrink-0 items-center text-slate-500">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <Folder size={12} className="shrink-0 text-amber-300" />
        {label}
        {actions}
      </div>
      {open && <FolderList scope={scope} dir={entry.path} depth={depth + 1} onDropInto={onDropInto} />}
    </DropTarget>
  )
}

function FolderList({ scope, dir, depth, onDropInto }: { scope: FileScope; dir: string; depth: number; onDropInto: (dir: string, picked: PickedFile[]) => void }) {
  const listed = useStoredFiles(scope, dir)
  if (listed.isPending) return <p className="text-[11px] text-slate-500" style={{ paddingLeft: depth * 12 + 14 }}><Loader2 size={11} className="inline animate-spin" /> Loading…</p>
  if (listed.isError) return <p className="text-[11px] text-red-300" style={{ paddingLeft: depth * 12 + 14 }}>{errorMessage(listed.error)}</p>
  if (!listed.data.length) return <p className="text-[11px] italic text-slate-600" style={{ paddingLeft: depth * 12 + 14 }}>{depth === 0 ? 'Nothing here yet. Drop files here, or upload them.' : 'Empty'}</p>
  return <>{listed.data.map((entry) => <Entry key={entry.path} scope={scope} entry={entry} depth={depth} onDropInto={onDropInto} />)}</>
}

export default function StoredFiles({ scope, dir = '', title = 'Files', waiting, onTaken }: {
  scope: FileScope
  dir?: string | undefined
  title?: string | undefined
  waiting?: { dir: string; picked: PickedFile[] } | undefined
  onTaken?: (() => void) | undefined
}) {
  const { upload, progress } = useStoredUpload(scope)
  const picker = useRef<HTMLInputElement>(null)
  const add = (into: string, picked: PickedFile[]) => upload.mutate({ dir: into, picked })
  const { mutate } = upload

  useEffect(() => {
    if (!waiting) return
    mutate(waiting)
    onTaken?.()
  }, [waiting, mutate, onTaken])

  return (
    <DropTarget label={`Drop to add to ${title}`} onFiles={(picked) => add(dir, picked)} className="min-h-[60px]">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</span>
        <button type="button" onClick={() => picker.current?.click()} disabled={upload.isPending} className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-200 disabled:opacity-50">
          <Upload size={11} /> Upload
        </button>
        <input ref={picker} type="file" multiple hidden aria-label={`Upload to ${title}`} onChange={(event) => { const picked = pickedFiles(event.target.files); event.target.value = ''; if (picked.length) add(dir, picked) }} />
      </div>
      {progress && <p className="text-[11px] text-sky-300">Uploading {progress.current} ({progress.done + 1} of {progress.total}, {Math.round(progress.share * 100)}%)</p>}
      {upload.isError && <p role="alert" className="text-[11px] text-red-300">{errorMessage(upload.error)}</p>}
      <FolderList scope={scope} dir={dir} depth={0} onDropInto={add} />
    </DropTarget>
  )
}
