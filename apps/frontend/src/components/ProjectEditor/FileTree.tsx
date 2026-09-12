import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ChevronDown, Folder, File, Loader2, Paperclip } from 'lucide-react'
import { listProjectFiles, projectFileKeys } from '../../api/project-files.js'
import type { RepoFileEntry } from './shared.js'

function sortedEntries(entries: RepoFileEntry[]): RepoFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function DirNode({ projectId, path, depth, activePath, onOpen, onAttach }: {
  projectId: string
  path: string
  depth: number
  activePath: string | null
  onOpen: (path: string) => void
  onAttach?: ((path: string, type: 'file' | 'dir') => void) | undefined
}) {
  const [open, setOpen] = useState(depth === 0)
  const { data, isLoading, isError } = useQuery({
    queryKey: projectFileKeys.tree(projectId, path),
    queryFn: () => listProjectFiles(projectId, path),
    enabled: open,
  })

  return (
    <div>
      {depth > 0 && (
        <div className="group flex items-center" style={{ paddingLeft: depth * 12 }}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex-1 min-w-0 flex items-center gap-1 text-[12px] text-slate-300 hover:bg-[var(--bark-700)] rounded px-1 py-0.5"
          >
            {open ? <ChevronDown size={12} className="text-slate-500 shrink-0" /> : <ChevronRight size={12} className="text-slate-500 shrink-0" />}
            <Folder size={12} className="text-sky-400 shrink-0" />
            <span className="truncate">{path.split('/').pop()}</span>
          </button>
          {onAttach && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onAttach(path, 'dir') }}
              className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bark-700)] text-slate-500 hover:text-emerald-300"
              title="Attach this folder as chat context"
            >
              <Paperclip size={11} />
            </button>
          )}
        </div>
      )}

      {open && (
        <div>
          {isLoading && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500" style={{ paddingLeft: (depth + 1) * 12 }}>
              <Loader2 size={11} className="animate-spin" /> Loading…
            </div>
          )}
          {isError && (
            <p className="text-[11px] text-red-400" style={{ paddingLeft: (depth + 1) * 12 }}>Could not load this folder.</p>
          )}
          {data && sortedEntries(data.entries).map((entry) => (
            entry.type === 'dir' ? (
              <DirNode
                key={entry.path} projectId={projectId} path={entry.path} depth={depth + 1}
                activePath={activePath} onOpen={onOpen} onAttach={onAttach}
              />
            ) : (
              <div key={entry.path} className="group flex items-center" style={{ paddingLeft: (depth + 1) * 12 + 14 }}>
                <button
                  type="button"
                  onClick={() => onOpen(entry.path)}
                  className={`flex-1 min-w-0 flex items-center gap-1 text-[12px] rounded px-1 py-0.5 truncate ${
                    activePath === entry.path ? 'bg-emerald-950/60 text-emerald-300' : 'text-slate-300 hover:bg-[var(--bark-700)]'
                  }`}
                >
                  <File size={12} className="text-slate-500 shrink-0" />
                  <span className="truncate">{entry.name}</span>
                </button>
                {onAttach && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onAttach(entry.path, 'file') }}
                    className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bark-700)] text-slate-500 hover:text-emerald-300"
                    title="Attach this file as chat context"
                  >
                    <Paperclip size={11} />
                  </button>
                )}
              </div>
            )
          ))}
          {data && data.entries.length === 0 && (
            <p className="text-[11px] text-slate-600 italic" style={{ paddingLeft: (depth + 1) * 12 }}>Empty</p>
          )}
        </div>
      )}
    </div>
  )
}

export function FileTree({ projectId, activePath, onOpen, onAttach }: {
  projectId: string
  activePath: string | null
  onOpen: (path: string) => void
  onAttach?: ((path: string, type: 'file' | 'dir') => void) | undefined
}) {
  return <DirNode projectId={projectId} path="" depth={0} activePath={activePath} onOpen={onOpen} onAttach={onAttach} />
}

export default FileTree
