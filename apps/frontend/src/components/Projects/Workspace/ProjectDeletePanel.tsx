import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2, X } from 'lucide-react'
import { deleteProject, getProjectRemoval, projectKeys } from '../../../api/projects.js'
import { errorMessage } from '../../../api/client.js'
import { chatPackKeys } from '../../../api/chat-pack.js'
import { projectRemovalLines, projectRemovalProgress } from './project-removal-text.js'

const isGone = (err: unknown) => (err as { response?: { status?: number } } | null)?.response?.status === 404

function DeleteProjectPopup({ projectId, onClose, onDeleted }: { projectId: string; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')
  const [started, setStarted] = useState(false)

  const preview = useQuery({
    queryKey: projectKeys.removal(projectId),
    queryFn: () => getProjectRemoval(projectId),
    retry: false,
    refetchInterval: (query) => (started && !isGone(query.state.error) ? 2_000 : false),
  })

  const remove = useMutation({
    mutationFn: () => deleteProject(projectId, typed),
    onSuccess: () => setStarted(true),
  })

  const gone = started && isGone(preview.error)
  const finish = () => {
    for (const queryKey of [projectKeys.list(), ['trees'], ['branches'], ['leaves'], chatPackKeys.conversations()]) {
      void qc.invalidateQueries({ queryKey })
    }
    onDeleted()
  }

  const data = preview.data
  const running = started && !gone && data?.state.state !== 'failed'

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50" role="dialog" aria-label="Delete project">
      <div className="w-full max-w-lg rounded-xl border border-[var(--bark-700)] bg-[var(--bark-900)] p-5 text-[13px] text-slate-300 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-100">Delete {data?.name ? `“${data.name}”` : 'this project'}</h3>
          {!running && <button type="button" aria-label="Close" onClick={gone ? finish : onClose} className="p-1 rounded hover:bg-[var(--bark-700)] cursor-pointer"><X size={14} /></button>}
        </div>

        {preview.isLoading && <p className="text-slate-500">Working out what goes with it…</p>}
        {preview.isError && !gone && <p className="text-red-400">{errorMessage(preview.error)}</p>}

        {gone && (
          <>
            <p className="text-emerald-300">The project and everything listed are deleted.</p>
            <button type="button" onClick={finish} className="px-3 py-1.5 rounded-md bg-[var(--bark-700)] hover:bg-[var(--bark-600)] cursor-pointer">Done</button>
          </>
        )}

        {data && !gone && started && (
          <div className="space-y-2" data-testid="project-removal-progress">
            <p className={data.state.state === 'failed' ? 'text-red-400' : 'text-amber-300'}>{projectRemovalProgress(data.state)}</p>
            {data.state.state === 'failed' && (
              <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} className="px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-50">Try again</button>
            )}
          </div>
        )}

        {data && !started && (
          <>
            {data.blockers.length > 0 ? (
              <div className="space-y-2">
                <p>It can't be deleted yet:</p>
                <ul className="list-disc pl-5 text-amber-300 space-y-1">{data.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <p>This deletes, and cannot be undone:</p>
                  <ul className="list-disc pl-5 space-y-1">{projectRemovalLines(data).map((line) => <li key={line}>{line}</li>)}</ul>
                  {data.keptConversations > 0 && (
                    <p className="text-slate-400">{data.keptConversations === 1 ? 'One conversation' : `${data.keptConversations} conversations`} about the project {data.keptConversations === 1 ? 'is' : 'are'} kept, no longer linked to it.</p>
                  )}
                </div>
                <label className="block text-[12px] text-slate-400">
                  Type <span className="font-mono text-slate-200">{data.name}</span> to confirm
                  <input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" className="mt-1 w-full rounded-md bg-[var(--bark-950)] border border-[var(--bark-700)] px-2 py-1.5 text-slate-100" />
                </label>
                {remove.error && <p className="text-red-400">{errorMessage(remove.error)}</p>}
                <div className="flex gap-2">
                  <button type="button" onClick={() => remove.mutate()} disabled={typed.trim() !== data.name || remove.isPending} className="px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                    {remove.isPending ? 'Starting…' : 'Delete project'}
                  </button>
                  <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md hover:bg-[var(--bark-700)] cursor-pointer">Keep it</button>
                </div>
              </>
            )}
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
