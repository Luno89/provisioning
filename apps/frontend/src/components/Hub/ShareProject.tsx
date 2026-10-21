import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Undo2, Users } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { useSharing } from './shared'

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export default function ShareProject({ project }: { project: { id: string; name: string } }) {
  const navigate = useNavigate()
  const { preview, share, takeBack } = useSharing(project.id)
  const [asking, setAsking] = useState(false)
  const [typed, setTyped] = useState('')

  if (preview.isPending) return <p className="p-3 text-[12px] text-slate-500"><Loader2 size={12} className="inline animate-spin" /> Reading…</p>
  if (preview.isError) return <p className="p-3 text-[12px] text-red-300">{errorMessage(preview.error)}</p>
  const { shared, moves, stays } = preview.data
  const failure = share.error ?? takeBack.error

  if (shared) {
    return (
      <div className="space-y-2 p-3 text-[12px]" data-testid="share-project">
        <p className="text-slate-300">{project.name} is shared. Its board, chats and repository are kept on the hub, and your instance keeps working it.</p>
        <button type="button" onClick={() => void navigate({ to: '/shared/$id', params: { id: shared.hubProjectId } })} className="inline-flex items-center gap-1 rounded border border-[var(--bark-600)] px-2.5 py-1 text-slate-200 hover:bg-[var(--bark-700)]"><Users size={12} /> People on {project.name}</button>
        <div className="space-y-1.5 rounded-md border border-[var(--bark-700)] p-2">
          <p className="text-slate-400">Take it back: everything returns to your instance only, the hub's copy is deleted and everyone else loses it. Type {project.name} to take it back.</p>
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); takeBack.mutate(typed, { onSuccess: () => setTyped('') }) }}>
            <input aria-label="The project's name, to take it back" value={typed} onChange={(event) => setTyped(event.target.value)} className="min-w-0 flex-1 rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-2 py-1 text-slate-200" />
            <button type="submit" disabled={typed !== project.name || takeBack.isPending} className="inline-flex items-center gap-1 rounded bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-500 disabled:opacity-40"><Undo2 size={12} /> {takeBack.isPending ? 'Taking it back…' : 'Take it back'}</button>
          </form>
        </div>
        {failure && <p role="alert" className="text-red-300">{errorMessage(failure)}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-2 p-3 text-[12px]" data-testid="share-project">
      <p className="text-slate-300">Share {project.name} to work on it with other people, as owners, collaborators or clients. Until you do, nothing of it leaves your instance.</p>
      {!asking ? (
        <button type="button" onClick={() => setAsking(true)} className="inline-flex items-center gap-1 rounded bg-[var(--leaf-stem)] px-2.5 py-1 font-medium text-white hover:brightness-110"><Users size={12} /> Share this project…</button>
      ) : (
        <div className="space-y-2 rounded-md border border-[var(--bark-700)] p-2" data-testid="share-confirm">
          <div>
            <p className="font-medium text-slate-200">Goes to the hub</p>
            <ul className="ml-4 list-disc text-slate-400">
              <li>the board: {count(moves.epics, 'epic', 'epics')}, {count(moves.features, 'feature', 'features')}, {count(moves.stories, 'story', 'stories')}, {count(moves.tasks, 'task', 'tasks')}</li>
              <li>the channel and the stories' and features' chats, with what was said in them ({count(moves.chats, 'chat', 'chats')})</li>
              <li>{moves.repository ? <>the repository {moves.repository}, kept in step with yours</> : 'no repository: this project has none'}</li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-slate-200">Stays on your instance</p>
            <ul className="ml-4 list-disc text-slate-400">{stays.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={share.isPending} onClick={() => share.mutate()} className="rounded bg-[var(--leaf-stem)] px-2.5 py-1 font-medium text-white hover:brightness-110 disabled:opacity-50">{share.isPending ? 'Sharing…' : `Share ${project.name}`}</button>
            <button type="button" onClick={() => setAsking(false)} className="text-slate-400 underline">Not now</button>
          </div>
        </div>
      )}
      {failure && <p role="alert" className="text-red-300">{errorMessage(failure)}</p>}
    </div>
  )
}
