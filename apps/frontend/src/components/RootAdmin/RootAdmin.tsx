import { useEffect } from 'react'
import { LogOut } from 'lucide-react'
import { People } from '../../features/accounts'
import { Invites } from '../../features/accounts'
import { PoolSection } from './PoolSection'

export default function RootAdmin({ section, onLogout }: { section?: 'pool' | undefined; onLogout: () => void }) {
  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView()
  }, [section])

  return (
    <div className="min-h-screen bg-[var(--bark-900)] p-6 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-6 rounded-2xl border border-[var(--bark-700)] bg-[var(--bark-800)] p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold">Koala admin</h1>
          <nav className="flex items-center gap-4 text-xs text-slate-400" aria-label="Sections">
            <a href="#/admin" className="hover:text-slate-200">People</a>
            <a href="#/pool" className="hover:text-slate-200">Koala's servers</a>
            <button type="button" onClick={onLogout} className="inline-flex items-center gap-1.5 hover:text-slate-200"><LogOut size={12} /> Sign out</button>
          </nav>
        </div>
        <People />
        <Invites />
        <PoolSection />
      </div>
    </div>
  )
}
