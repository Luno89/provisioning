import { Link } from '@tanstack/react-router'
import { Loader2, Users } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { ROLE_SAID, useSharedProjects } from './shared'

export default function SharedProjects() {
  const mine = useSharedProjects()
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-6" data-testid="shared-projects">
      <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100"><Users size={18} className="text-[var(--leaf)]" /> Shared projects</h1>
      <p className="text-[12px] text-slate-400">Projects you are on with other people. Share one of yours from its Settings → People.</p>
      {mine.isPending && <p className="text-[12px] text-slate-500"><Loader2 size={12} className="inline animate-spin" /> Reading…</p>}
      {mine.isError && <p className="text-[12px] text-red-300">{errorMessage(mine.error)}</p>}
      {mine.data && mine.data.length === 0 && <p className="text-[12px] text-slate-500">You are on no shared project yet.</p>}
      <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
        {(mine.data ?? []).map((entry) => (
          <li key={entry.project.id}>
            <Link to="/shared/$id" params={{ id: entry.project.id }} className="flex items-center gap-2 px-3 py-2 text-[13px] text-slate-200 hover:bg-[var(--bark-800)]">
              <span className="flex-1">{entry.project.name}</span>
              <span className="text-[11px] text-slate-500">{ROLE_SAID[entry.role].title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
