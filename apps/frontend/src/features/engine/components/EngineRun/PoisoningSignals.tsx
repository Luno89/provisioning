import { ShieldAlert } from 'lucide-react'
import { errorMessage } from '../../../../api/client'
import { useRunSignals, useSignalActions } from '../../hooks/usePoisoning'
import { openSignals, retiresWhat, SEVERITY_WORDS, SIGNAL_TITLES, severityTone } from '../../lib/poisoning'
import type { SignalView } from '../../types/poisoning'

const TONE = {
  bad: 'text-rose-300',
  warn: 'text-amber-300',
  quiet: 'text-slate-400',
}

const button = 'rounded border border-[var(--bark-700)] px-2 py-0.5 text-[11px] text-slate-300 hover:bg-[var(--bark-800)] disabled:opacity-50'

export function SignalRow({ signal, className, onChanged }: { signal: SignalView; className?: string; onChanged?: () => void }) {
  const actions = useSignalActions(onChanged)
  const busy = actions.dismiss.isPending || actions.retire.isPending
  const failed = actions.dismiss.error ?? actions.retire.error
  const retired = actions.retire.data?.retired
  return (
    <li className={className} data-testid="poisoning-signal">
      <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${TONE[severityTone(signal.severity)]}`}>
        <ShieldAlert size={11} /> {SEVERITY_WORDS[signal.severity]}
      </span>
      <span className="font-semibold text-slate-100">{SIGNAL_TITLES[signal.kind]}</span>
      <span className="flex-1 text-slate-400">{signal.said}.</span>
      {signal.state === 'open' && (
        <span className="flex flex-wrap gap-1.5">
          {retiresWhat(signal) && (
            <button type="button" className={button} disabled={busy} onClick={() => actions.retire.mutate({ id: signal.id, scope: 'run' })}>Retire what it left</button>
          )}
          {retiresWhat(signal) && signal.host && (
            <button type="button" className={button} disabled={busy} onClick={() => actions.retire.mutate({ id: signal.id, scope: 'source' })}>Retire everything from {signal.host}</button>
          )}
          <button type="button" className={button} disabled={busy} onClick={() => actions.dismiss.mutate(signal.id)}>Dismiss</button>
        </span>
      )}
      {signal.state !== 'open' && <span className="text-[11px] text-slate-500">{signal.state === 'dismissed' ? 'Dismissed' : 'Dealt with'}</span>}
      {signal.matched && (
        <details className="basis-full text-[11px]">
          <summary className="cursor-pointer text-slate-500">What matched</summary>
          <p className="mt-1 whitespace-pre-wrap break-all font-mono text-slate-300">{signal.matched}</p>
        </details>
      )}
      {retired !== undefined && <p className="basis-full text-[11px] text-emerald-300">Retired {retired} {retired === 1 ? 'memory' : 'memories'}.</p>}
      {failed && <p className="basis-full text-[11px] text-rose-300">{errorMessage(failed)}</p>}
    </li>
  )
}

export function RunSignals({ runId }: { runId: string | undefined }) {
  const signals = useRunSignals(runId)
  const shown = openSignals(signals.data ?? [])
  if (!shown.length) return null
  return (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs space-y-1.5" data-testid="run-signals">
      <p className="font-semibold text-rose-200">Koala noticed something in this run</p>
      <ul className="space-y-1.5">
        {shown.map((signal) => <SignalRow key={signal.id} signal={signal} className="flex flex-wrap items-center gap-x-3 gap-y-1" />)}
      </ul>
    </div>
  )
}
