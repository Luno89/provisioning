import { useRef, type ReactNode } from 'react'
import { Upload } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { pickedFiles, type PickedFile } from '../../lib/file-drop'
import DropTarget from './DropTarget'
import { useRepositoryDrop } from './shared'

export default function RepositoryFiles({ projectId, branch, title = 'Repository', children }: {
  projectId: string
  branch?: string | undefined
  title?: string | undefined
  children: (onDropFiles: (dir: string, picked: PickedFile[]) => void) => ReactNode
}) {
  const { drop, share } = useRepositoryDrop(projectId, branch)
  const picker = useRef<HTMLInputElement>(null)
  const commit = (dir: string, picked: PickedFile[]) => drop.mutate({ dir, picked })
  const where = branch ? `the branch ${branch}` : 'main'

  return (
    <DropTarget label={`Drop code to commit to ${where}`} onFiles={(picked) => commit('', picked)}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</span>
        <button type="button" onClick={() => picker.current?.click()} disabled={drop.isPending} title={`Commit files to ${where}`} className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-200 disabled:opacity-50">
          <Upload size={11} /> Add code
        </button>
        <input ref={picker} type="file" multiple hidden aria-label={`Commit files to ${where}`} onChange={(event) => { const picked = pickedFiles(event.target.files); event.target.value = ''; if (picked.length) commit('', picked) }} />
      </div>
      {drop.isPending && <p className="text-[11px] text-sky-300">Committing to {where}{share !== undefined ? ` (${Math.round(share * 100)}%)` : ''}…</p>}
      {drop.isSuccess && !drop.isPending && <p className="text-[11px] text-emerald-300/90">Committed {drop.data.paths.length === 1 ? drop.data.paths[0] : `${drop.data.paths.length} files`} to {where}.</p>}
      {drop.isError && <p role="alert" className="text-[11px] text-red-300">{errorMessage(drop.error)}</p>}
      {children(commit)}
    </DropTarget>
  )
}
