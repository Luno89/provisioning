import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import StudioCrumbs from './StudioCrumbs'

export default function StudioFrame({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <StudioCrumbs trail={[{ label: 'Studio', to: '/studio/agents' }, { label: title }]} />
      <h1 className="flex items-center gap-2 text-xl font-bold text-slate-100">
        <Icon size={22} className="text-[var(--leaf)]" /> {title}
      </h1>
      {children}
    </div>
  )
}
