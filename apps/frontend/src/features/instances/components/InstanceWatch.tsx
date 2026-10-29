import { errorMessage } from '../../../api/client'
import { useInstanceWatch, useSetInstanceWatch, type WatchView } from '../api/instance-watch'

const when = (at: string): string => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function UnreachableSwitch({ view, saving, error, onChange }: { view: WatchView; saving: boolean; error?: unknown; onChange: (on: boolean) => void }) {
  return (
    <div className="space-y-1">
      {view.alwaysTold ? (
        <p className="text-xs text-slate-400">
          Your instance runs on Koala's servers, so root always emails you, and Koala's operator, when it stops answering for ten minutes.
        </p>
      ) : (
        <label className="flex items-start gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={view.notifyWhenUnreachable}
            disabled={saving}
            onChange={(event) => onChange(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold text-slate-200">Email me when my instance stops answering</span>{' '}
            <span className="text-slate-500">After ten minutes, and once when it is back. Switch this off if your instance runs on a laptop that sleeps.</span>
          </span>
        </label>
      )}
      {view.reach && !view.reach.reachable && view.reach.unreachableSince && (
        <p role="status" className="text-xs text-amber-300">Root has not reached your instance since {when(view.reach.unreachableSince)}.</p>
      )}
      {error ? <p className="text-xs text-rose-300">{errorMessage(error)}</p> : null}
    </div>
  )
}

export function InstanceWatch() {
  const watch = useInstanceWatch()
  const change = useSetInstanceWatch()
  const view = watch.data
  if (!view) return null
  return (
    <div className="pt-6 border-t border-slate-700" data-testid="instance-watch">
      <h4 className="text-lg font-bold text-white mb-1">When this instance cannot be reached</h4>
      <UnreachableSwitch view={view} saving={change.isPending} error={change.error} onChange={(on) => change.mutate(on)} />
    </div>
  )
}

export default InstanceWatch
