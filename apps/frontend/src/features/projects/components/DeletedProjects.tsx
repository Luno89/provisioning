import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listDeletedProjects, projectKeys, purgeProject, restoreProject } from '../api/projects'
import { errorMessage } from '../../../api/client'
import { longDate } from '../lib/project-deletion'
import { useDeletionsStore } from '../stores/deletions'
import type { DeletedProject } from '../types/project-removal'

function DeletedProjectRow({ project, onOpenProject }: { project: DeletedProject; onOpenProject: (id: string) => void }) {
  const qc = useQueryClient()
  const noteRestored = useDeletionsStore((state) => state.noteRestored)
  const follow = useDeletionsStore((state) => state.follow)
  const [purging, setPurging] = useState(false)
  const [typed, setTyped] = useState('')
  const refresh = () => { for (const queryKey of [projectKeys.list(), projectKeys.deleted()]) void qc.invalidateQueries({ queryKey }) }

  const restore = useMutation({
    mutationFn: () => restoreProject(project.id),
    onSuccess: (restored) => {
      noteRestored(project.id, restored)
      refresh()
      onOpenProject(project.id)
    },
  })
  const purge = useMutation({
    mutationFn: () => purgeProject(project.id, typed),
    onSuccess: () => {
      follow({ projectId: project.id, name: project.name, mode: 'permanent' })
      refresh()
    },
  })

  return (
    <li aria-label={project.name} className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3 text-[12px] text-slate-300 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold text-slate-100">{project.name}</p>
          <p className="text-slate-400">Deleted on {longDate(project.deletedAt)} · {project.keptUntil ? `Deleted for good on ${longDate(project.keptUntil)}` : 'The date it goes for good cannot be read now'}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => restore.mutate()} disabled={restore.isPending} className="px-3 py-1.5 rounded-md bg-[var(--bark-700)] hover:bg-[var(--bark-600)] cursor-pointer disabled:opacity-50">Restore</button>
          {!purging && <button type="button" onClick={() => setPurging(true)} className="px-3 py-1.5 rounded-md border border-red-800 text-red-300 hover:bg-red-950 cursor-pointer">Delete permanently now</button>}
        </div>
      </div>
      {restore.error && <p className="text-red-400">{errorMessage(restore.error)}</p>}
      {purging && (
        <div className="space-y-2">
          <p className="text-red-300">Its code, trees, chats, runs and builds, and the files you uploaded are deleted now. Nothing is kept.</p>
          <label className="block text-slate-400">
            Type <span className="font-mono text-slate-200">{project.name}</span> to confirm
            <input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" className="mt-1 w-full rounded-md bg-[var(--bark-950)] border border-[var(--bark-700)] px-2 py-1.5 text-slate-100" />
          </label>
          {purge.error && <p className="text-red-400">{errorMessage(purge.error)}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => purge.mutate()} disabled={typed.trim() !== project.name || purge.isPending} className="px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">Delete {project.name} for good</button>
            <button type="button" onClick={() => setPurging(false)} className="px-3 py-1.5 rounded-md hover:bg-[var(--bark-700)] cursor-pointer">Keep it</button>
          </div>
        </div>
      )}
    </li>
  )
}

export function DeletedProjects({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const deleted = useQuery({ queryKey: projectKeys.deleted(), queryFn: listDeletedProjects })
  if (deleted.isError) return <p className="px-3 text-[12px] text-red-400">{errorMessage(deleted.error)}</p>
  if (!deleted.data?.length) return null
  return (
    <section className="px-3 pb-6 space-y-2" aria-label="Deleted projects">
      <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Deleted projects</h3>
      <ul className="space-y-2">{deleted.data.map((project) => <DeletedProjectRow key={project.id} project={project} onOpenProject={onOpenProject} />)}</ul>
    </section>
  )
}

export default DeletedProjects
