import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { useChangeInstanceUpdates, useInstanceUpdates, type ReleaseRow, type UpdatesView } from '../api/instance-updates'

const versionOf = (view: UpdatesView, imageTag: string | undefined): string | undefined =>
  imageTag ? view.releases.find((row) => row.imageTag === imageTag)?.version ?? imageTag : undefined

const day = (at: string): string => new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function Release({ row, view, moving, onMove }: { row: ReleaseRow; view: UpdatesView; moving: boolean; onMove: () => void }) {
  const runningAt = view.releases.find((other) => other.running)?.servedAt
  const back = Boolean(runningAt && row.servedAt < runningAt)
  return (
    <li className="rounded-xl border border-white/5 bg-slate-900/40 px-3 py-2" data-testid={`release-${row.version}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-slate-100">{row.version}</span>
        <span className="text-[11px] text-slate-500">{day(row.servedAt)}</span>
        {row.hotfix && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">Hotfix</span>}
        {row.running && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">Running</span>}
        {row.withdrawn && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-300" title={`Withdrawn when ${row.withdrawn.by}`}>Withdrawn</span>}
        {row.current && !row.running && <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-300">Newest</span>}
        {row.choosable && (
          <button type="button" className="ml-auto text-xs font-semibold text-sky-300 hover:text-sky-200 disabled:opacity-50" disabled={moving} onClick={onMove}>
            {back ? 'Go back to this version' : 'Move to this version'}
          </button>
        )}
      </div>
      {row.notes && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-slate-400">What it is</summary>
          <p className="mt-1 whitespace-pre-wrap text-xs text-slate-400">{row.notes}</p>
        </details>
      )}
    </li>
  )
}

export function InstanceUpdates() {
  const updates = useInstanceUpdates()
  const change = useChangeInstanceUpdates()
  const view = updates.data
  if (!view) return updates.isError ? <p role="alert" className="text-xs text-red-300">{errorMessage(updates.error)}</p> : null

  const running = versionOf(view, view.running)
  const target = versionOf(view, view.target)
  const moving = view.target !== view.running

  return (
    <div className="pt-6 border-t border-slate-700" data-testid="instance-updates">
      <h4 className="text-lg font-bold text-white mb-1">Updates</h4>
      <p className="text-xs text-slate-400">
        {running ? <>This instance runs <span className="font-mono text-slate-200">{running}</span>.</> : 'This instance has not said which release it runs yet.'}
      </p>
      {view.runningWithdrawn && (
        <div role="alert" className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" data-testid="running-withdrawn">
          <p>{running} was withdrawn when {view.runningWithdrawn.by}. Your instance stays on it until you move it.</p>
          {view.current !== view.running && (
            <button
              type="button"
              className="mt-1 font-semibold text-red-100 underline hover:text-white disabled:opacity-50"
              disabled={change.isPending}
              onClick={() => change.mutate({ version: versionOf(view, view.current) ?? view.current })}
            >
              Move to {versionOf(view, view.current)}, which Koala runs
            </button>
          )}
        </div>
      )}
      {view.checking && moving && (
        <p role="status" className="mt-2 flex items-center gap-2 text-xs text-amber-200">
          <Loader2 size={12} className="animate-spin" /> Moving to {target}. Your instance restarts on it; if it does not come up, it goes back to {running ?? 'what it ran'} by itself.
        </p>
      )}
      {!view.checking && moving && (
        <p role="status" className="mt-2 text-xs text-slate-400">It moves to {target} at its next check-in, within the hour.</p>
      )}
      <label className="mt-3 flex items-start gap-3 text-sm text-slate-200">
        <input
          type="checkbox"
          className="mt-1"
          checked={view.auto}
          disabled={change.isPending}
          onChange={(event) => change.mutate({ auto: event.target.checked })}
        />
        <span>
          Update automatically
          <span className="block text-xs text-slate-400">
            {view.auto
              ? 'Your instance moves to each new release once Koala itself runs it, hotfixes included.'
              : 'Your instance stays on the release it runs until you move it. You can move to any newer release, or back to the one it ran before.'}
          </span>
        </span>
      </label>
      {view.releases.length > 0 && (
        <ul className="mt-3 space-y-2">
          {view.releases.map((row) => (
            <Release key={row.imageTag} row={row} view={view} moving={change.isPending} onMove={() => change.mutate({ version: row.version })} />
          ))}
        </ul>
      )}
      {change.isError && <p role="alert" className="mt-2 text-xs text-red-300">{errorMessage(change.error)}</p>}
    </div>
  )
}
