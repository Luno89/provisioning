import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2, X } from 'lucide-react'
import { deleteProject, getProjectRemoval, projectKeys } from '../../api/projects.js'
import { errorMessage } from '../../../../api/client.js'
import { confirmationText, keptUntilFrom } from '../../lib/project-deletion.js'
import { useDeletionsStore } from '../../stores/deletions.js'
import type { ProjectDeletionMode } from '../../types/project-removal.js'

function DeleteProjectPopup({ projectId, onClose, onDeleted }: { projectId: string; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient()
  const follow = useDeletionsStore((state) => state.follow)
  const [typed, setTyped] = useState('')
  const [mode, setMode] = useState<ProjectDeletionMode>('archive')
  const [keptUntil] = useState(() => keptUntilFrom(new Date()))

  const preview = useQuery({ queryKey: projectKeys.removal(projectId), queryFn: () => getProjectRemoval(projectId), retry: false })

  const remove = useMutation({
    mutationFn: ({ name, chosen }: { name: string; chosen: ProjectDeletionMode }) => deleteProject(projectId, typed, chosen).then((deletion) => ({ name, deletion })),
    onSuccess: ({ name, deletion }) => {
      follow({ projectId, name, mode: deletion.mode })
      if (deletion.progress) qc.setQueryData(projectKeys.deletion(projectId), deletion.progress)
      void qc.invalidateQueries({ queryKey: projectKeys.list() })
      onDeleted()
    },
  })

  const data = preview.data
  const text = data ? confirmationText(data, mode, keptUntil) : undefined
  const ready = data !== undefined && typed.trim() === data.name && !remove.isPending
  const start = (chosen: ProjectDeletionMode) => { if (data) remove.mutate({ name: data.name, chosen }) }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50" role="dialog" aria-label="Delete project">
      <div className="w-full max-w-lg rounded-xl border border-[var(--bark-700)] bg-[var(--bark-900)] p-5 text-[13px] text-slate-300 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-100">Delete {data?.name ? `“${data.name}”` : 'this project'}</h3>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 rounded hover:bg-[var(--bark-700)] cursor-pointer"><X size={14} /></button>
        </div>

        {preview.isLoading && <p className="text-slate-500">Working out what goes with it…</p>}
        {preview.isError && <p className="text-red-400">{errorMessage(preview.error)}</p>}

        {data && text && (
          <>
            <div className="space-y-1">
              <p>Deleted now:</p>
              <ul className="list-disc pl-5 space-y-1">{text.now.map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
            {text.kept ? (
              <div className="space-y-1">
                <p>Kept for 90 days, until {text.kept.until}, then deleted for good:</p>
                <ul className="list-disc pl-5 space-y-1">{text.kept.lines.map((line) => <li key={line}>{line}</li>)}</ul>
                <p className="text-slate-400">You can restore it from Deleted projects until then.</p>
              </div>
            ) : (
              <p className="text-red-300">Nothing is kept, and it cannot be restored.</p>
            )}
            {data.keptConversations > 0 && (
              <p className="text-slate-400">{data.keptConversations === 1 ? 'One conversation' : `${data.keptConversations} conversations`} about the project {data.keptConversations === 1 ? 'is' : 'are'} kept, no longer linked to it.</p>
            )}
            <label className="block text-[12px] text-slate-400">
              Type <span className="font-mono text-slate-200">{data.name}</span> to confirm
              <input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" className="mt-1 w-full rounded-md bg-[var(--bark-950)] border border-[var(--bark-700)] px-2 py-1.5 text-slate-100" />
            </label>
            {remove.error && <p className="text-red-400">{errorMessage(remove.error)}</p>}
            <div className="flex flex-wrap gap-2">
              {mode === 'archive' ? (
                <>
                  <button type="button" onClick={() => start('archive')} disabled={!ready} className="px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">Delete project</button>
                  <button type="button" onClick={() => setMode('permanent')} disabled={!ready} className="px-3 py-1.5 rounded-md border border-red-800 text-red-300 hover:bg-red-950 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">Delete permanently now</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => start('permanent')} disabled={!ready} className="px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">Delete permanently now</button>
                  <button type="button" onClick={() => setMode('archive')} className="px-3 py-1.5 rounded-md hover:bg-[var(--bark-700)] cursor-pointer">Keep it for 90 days instead</button>
                </>
              )}
              <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md hover:bg-[var(--bark-700)] cursor-pointer">Keep it</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function ProjectDeletePanel({ projectId, onDeleted }: { projectId: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="px-3 py-2 text-[12px] text-slate-400" data-testid="project-delete">
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--bark-700)] hover:bg-[var(--bark-700)] cursor-pointer">
        <Trash2 size={12} /> Delete this project…
      </button>
      {open && <DeleteProjectPopup projectId={projectId} onClose={() => setOpen(false)} onDeleted={() => { setOpen(false); onDeleted() }} />}
    </div>
  )
}

export default ProjectDeletePanel
