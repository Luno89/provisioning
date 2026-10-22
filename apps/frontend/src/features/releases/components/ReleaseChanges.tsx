import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { ReleaseChanges as Changes } from '../api/releases'

const ITEM_STATE: Record<Changes['items'][number]['state'], { label: string; tone: string }> = {
  kept: { label: 'kept', tone: 'text-emerald-300' },
  reset: { label: 'reset', tone: 'text-rose-300' },
  'switched-off': { label: 'switched off', tone: 'text-rose-300' },
  gone: { label: 'gone', tone: 'text-rose-300' },
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function ReleaseChanges({ changes }: { changes?: Changes | undefined }) {
  if (!changes) return <p className="text-[11px] text-slate-500">This preview was not compared with live, so what it would change is not known.</p>
  const emptyDrops = changes.tables.filter((entry) => entry.rows === 0).length + changes.columns.filter((entry) => entry.filled === 0).length
  const emptyRetypes = changes.retyped.filter((entry) => entry.filled === 0).length

  return (
    <div className="space-y-1.5" data-testid="release-changes">
      <h5 className="text-[10px] font-black uppercase tracking-widest text-slate-500">What this release changes</h5>
      {changes.losing ? (
        <div className="space-y-1 rounded border border-rose-500/30 bg-rose-500/5 p-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-rose-300"><AlertTriangle size={11} /> Cutting it over loses:</p>
          <ul className="list-disc pl-5 text-[11px] text-slate-300 space-y-0.5">
            {changes.lost.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-300"><CheckCircle2 size={11} /> Compared with live, nothing is lost.</p>
      )}
      {(emptyDrops > 0 || emptyRetypes > 0) && (
        <p className="text-[11px] text-slate-500">
          {[emptyDrops ? `it drops ${count(emptyDrops, 'empty table or column', 'empty tables or columns')}` : '', emptyRetypes ? `changes the type of ${count(emptyRetypes, 'empty column')}` : ''].filter(Boolean).join(' and ')}; nothing in them is lost.
        </p>
      )}
      {changes.items.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-slate-400">Made or changed in the app: {count(changes.items.length, 'thing')}</summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {changes.items.map((item) => (
              <li key={`${item.kind}:${item.key}`} className="flex gap-2">
                <span className={`shrink-0 ${ITEM_STATE[item.state].tone}`}>{ITEM_STATE[item.state].label}</span>
                <span className="text-slate-300">{item.name.replace(/,$/, '')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
