import { useState } from 'react'
import { BellOff, Loader2 } from 'lucide-react'
import type { AlertEpisode, AlertRule, FiringAlert, HealthState, HistoryState, Range } from '../api/monitoring'
import { RANGES } from '../api/monitoring'
import { errorMessage } from '../../../api/client'
import { ago } from '../../projects'
import { RANGE_LABELS, STATE_LOOK, useRemoveRule, useSetHistory } from '../shared'

export function StateBadge({ state }: { state: HealthState }) {
  const look = STATE_LOOK[state]
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${look.text}`} data-testid="state-badge">
      <span className={`h-2 w-2 rounded-full ${look.dot}`} aria-hidden="true" />
      {look.label}
    </span>
  )
}

export function RangePicker({ range, onPick }: { range: Range; onPick: (range: Range) => void }) {
  return (
    <div className="inline-flex rounded-md border border-[var(--bark-600)] p-0.5" role="group" aria-label="Time range">
      {RANGES.map((choice) => (
        <button
          key={choice}
          type="button"
          aria-pressed={choice === range}
          onClick={() => onPick(choice)}
          className={`rounded px-2 py-0.5 text-[11px] ${choice === range ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
        >
          {RANGE_LABELS[choice]}
        </button>
      ))}
    </div>
  )
}

export function Bar({ label, share }: { label: string; share: number | undefined }) {
  const width = share === undefined ? 0 : Math.min(100, Math.round(share * 100))
  const tone = share === undefined ? 'bg-slate-600' : share >= 0.9 ? 'bg-rose-500' : share >= 0.75 ? 'bg-amber-400' : 'bg-emerald-400'
  return (
    <div className="text-[11px]">
      <div className="flex justify-between text-slate-400"><span>{label}</span><span>{share === undefined ? '—' : `${width}%`}</span></div>
      <div className="mt-0.5 h-1.5 rounded bg-[var(--bark-700)]" role="meter" aria-label={label} aria-valuenow={width} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-1.5 rounded ${tone}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}

export function HistorySetting({ clusterId, history }: { clusterId: string; history: HistoryState }) {
  if (history.byKoala) {
    return (
      <div className="space-y-1.5 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3 text-[12px]" data-testid="history-setting">
        <div className="font-semibold text-slate-200">History kept</div>
        <p className="text-[11px] text-slate-500">Koala's servers watch this cluster and keep {history.kept ?? history.days} days of its measurements.</p>
      </div>
    )
  }
  return <OwnHistorySetting clusterId={clusterId} history={history} />
}

function OwnHistorySetting({ clusterId, history }: { clusterId: string; history: HistoryState }) {
  const [days, setDays] = useState(String(history.days))
  const save = useSetHistory(clusterId)
  const wanted = Number(days)
  const valid = Number.isInteger(wanted) && wanted >= 1 && wanted <= 365
  return (
    <div className="space-y-1.5 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3 text-[12px]" data-testid="history-setting">
      <div className="font-semibold text-slate-200">History kept</div>
      <p className="text-[11px] text-slate-500">
        How many days of measurements this cluster keeps. More days use more disk on the cluster (about half a gigabyte a day).
        {history.kept !== undefined && ` It keeps ${history.kept} days now.`}
        {!history.applied && history.kept !== history.days && ` ${history.days} days are wanted and are being applied.`}
      </p>
      {history.problem && <p className="text-[11px] text-rose-300">It could not be applied: {history.problem}</p>}
      {history.canChange ? (
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (valid) save.mutate(wanted) }}>
          <label className="flex items-center gap-1.5 text-slate-300">
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              className="w-20 rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-2 py-0.5 text-slate-100"
              aria-label="Days of history"
            />
            days
          </label>
          <button type="submit" disabled={!valid || save.isPending || wanted === history.days} className="rounded border border-[var(--bark-600)] px-2 py-0.5 text-[11px] text-slate-200 hover:bg-[var(--bark-700)] disabled:opacity-50">
            {save.isPending ? <Loader2 size={11} className="animate-spin" /> : 'Save'}
          </button>
          {save.isError && <span className="text-[11px] text-rose-300">{errorMessage(save.error)}</span>}
        </form>
      ) : (
        <p className="text-[11px] text-slate-500">Only whoever owns this cluster can change it.</p>
      )}
    </div>
  )
}

export function FiringList({ firing }: { firing: FiringAlert[] }) {
  if (!firing.length) return null
  return (
    <ul className="space-y-1" aria-label="Firing alerts">
      {firing.map((alert) => (
        <li key={`${alert.clusterId ?? ''}${alert.key}`} className="flex items-center gap-2 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-1.5 text-[12px] text-rose-200">
          <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
          <span className="flex-1">{alert.summary}</span>
          {alert.since && <span className="text-[11px] text-rose-300/70">since {ago(alert.since)}</span>}
        </li>
      ))}
    </ul>
  )
}

export function RuleList({ rules }: { rules: AlertRule[] }) {
  const remove = useRemoveRule()
  const [confirming, setConfirming] = useState<string | undefined>()
  if (!rules.length) return <p className="text-[11px] text-slate-500">No alerts of yours are set. Ask Koala to set one, for example “tell me when it is down for 5 minutes”.</p>
  return (
    <ul className="space-y-1" aria-label="Alerts set">
      {rules.map((rule) => (
        <li key={rule.id} className="flex items-center gap-2 text-[12px] text-slate-300">
          <span className="flex-1">{rule.summary}</span>
          {confirming === rule.id ? (
            <>
              <button type="button" onClick={() => remove.mutate(rule.id)} disabled={remove.isPending} className="rounded bg-rose-600 px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50">Remove it</button>
              <button type="button" onClick={() => setConfirming(undefined)} className="text-[11px] text-slate-400">Keep</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(rule.id)} className="flex items-center gap-1 rounded border border-[var(--bark-600)] px-2 py-0.5 text-[11px] text-slate-300 hover:bg-[var(--bark-700)]">
              <BellOff size={11} /> Remove
            </button>
          )}
        </li>
      ))}
      {remove.isError && <li className="text-[11px] text-rose-300">{errorMessage(remove.error)}</li>}
    </ul>
  )
}

export function EpisodeList({ episodes }: { episodes: AlertEpisode[] }) {
  if (!episodes.length) return <p className="text-[11px] text-slate-500">No alerts have fired.</p>
  return (
    <ul className="space-y-1" aria-label="Alert history">
      {episodes.map((episode) => (
        <li key={episode.id} className="flex items-center gap-2 text-[12px]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${episode.resolvedAt ? 'bg-slate-500' : 'bg-rose-500'}`} aria-hidden="true" />
          <span className="flex-1 text-slate-300">{episode.summary}</span>
          <span className="text-[11px] text-slate-500">{ago(episode.startedAt)}{episode.resolvedAt ? `, resolved ${ago(episode.resolvedAt)}` : ', still firing'}</span>
        </li>
      ))}
    </ul>
  )
}

export function Section({ title, children, right, id }: { title: string; children: React.ReactNode; right?: React.ReactNode; id?: string }) {
  return (
    <section className="scroll-mt-4 space-y-2" id={id}>
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}
