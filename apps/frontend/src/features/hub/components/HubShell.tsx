import { Link } from '@tanstack/react-router'
import { LogOut, Users } from 'lucide-react'
import type { ReactNode } from 'react'

export default function HubShell({ email, onLogout, children }: { email: string; onLogout: () => void; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--bark-900)] text-slate-100" data-testid="hub-shell">
      <header className="flex items-center gap-3 border-b border-[var(--bark-700)] px-4 py-2">
        <Link to="/shared" className="flex items-center gap-2 text-[13px] font-semibold text-slate-100"><Users size={15} className="text-[var(--leaf)]" /> Shared projects</Link>
        <span className="ml-auto text-[12px] text-slate-400">{email}</span>
        <button type="button" onClick={onLogout} aria-label="Sign out" className="rounded p-1 text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-100"><LogOut size={14} /></button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
