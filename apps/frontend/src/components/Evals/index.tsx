import { useState } from 'react'
import { FlaskConical, GitCompare, ListChecks } from 'lucide-react'
import Level1Panel from './Level1Panel'
import Level2Panel from './Level2Panel'
import ComparePanel from './ComparePanel'

export type EvalsTab = 'level1' | 'level2' | 'compare'

const TABS: { id: EvalsTab; label: string; icon: typeof ListChecks }[] = [
  { id: 'level1', label: 'Level 1 · one turn', icon: ListChecks },
  { id: 'level2', label: 'Level 2 · whole procedures', icon: FlaskConical },
  { id: 'compare', label: 'Compare runs', icon: GitCompare },
]

export default function EvalsArea({ initialTab = 'level1' }: { initialTab?: EvalsTab }) {
  const [tab, setTab] = useState<EvalsTab>(initialTab)

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex items-center gap-2 border-b border-[var(--bark-800)] pb-px">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={`flex items-center gap-2 rounded-t-md border-b-2 px-4 py-2 text-xs font-medium transition-all ${
              tab === entry.id
                ? 'border-[var(--leaf)] bg-[var(--bark-900)]/80 font-semibold text-[var(--leaf)]'
                : 'border-transparent text-slate-400 hover:bg-[var(--bark-900)]/40 hover:text-slate-200'
            }`}
          >
            <entry.icon size={14} /> {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'level1' && <Level1Panel />}
      {tab === 'level2' && <Level2Panel />}
      {tab === 'compare' && <ComparePanel />}
    </div>
  )
}
