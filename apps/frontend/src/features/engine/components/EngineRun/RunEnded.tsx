import { useShellStore } from '../../../platform'
import { endedLine, endedTone, handoverLine, type RunEnding } from '../../lib/run-endings'

const TONE = {
  good: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
  warn: 'text-amber-200 bg-amber-500/10 border-amber-500/30',
  bad: 'text-rose-200 bg-rose-500/10 border-rose-500/30',
}

export default function RunEnded({ ending }: { ending: RunEnding | undefined }) {
  const viewer = useShellStore((s) => s.user?.email)
  if (!ending?.ended) return null
  const handover = handoverLine(ending)
  return (
    <div className={`rounded-md border px-3 py-2 text-xs space-y-1.5 ${TONE[endedTone(ending.ended)]}`} data-testid="run-ended">
      <p className="font-semibold">{endedLine(ending.ended, viewer)}</p>
      {handover && <p className="text-[11px] opacity-80">{handover}</p>}
      {ending.handover?.note && (
        <details open className="rounded border border-[var(--bark-800)] bg-[var(--bark-950)]">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-slate-300">Handover note</summary>
          <p className="whitespace-pre-wrap px-2 pb-2 text-slate-200" data-testid="handover-note">{ending.handover.note}</p>
        </details>
      )}
    </div>
  )
}
