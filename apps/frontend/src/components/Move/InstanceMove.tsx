import { useInstanceMove, useInstanceTrial, useStartInstanceMove, useStopInstanceMove } from '../../api/instances'
import { MovePanel } from './MovePanel'

export function InstanceMove() {
  const trial = useInstanceTrial()
  const onPool = Boolean(trial.data?.trialEndsAt)
  const move = useInstanceMove(onPool)
  const start = useStartInstanceMove()
  const stop = useStopInstanceMove()
  if (!onPool) return null
  return (
    <div className="pt-6 border-t border-slate-700" id="move">
      <h4 className="text-lg font-bold text-white mb-1">Move to your own machine</h4>
      <MovePanel
        move={move.data}
        command={start.data}
        starting={start.isPending}
        stopping={stop.isPending}
        error={start.error ?? stop.error ?? move.error}
        onStart={() => start.mutate()}
        onStop={() => stop.mutate()}
      />
    </div>
  )
}

export function MovingPage() {
  const trial = useInstanceTrial()
  const move = useInstanceMove(Boolean(trial.data?.trialEndsAt))
  const state = move.data?.state
  if (state !== 'copying' && state !== 'switching') return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bark-900)] p-6 text-slate-100">
      <div className="w-full max-w-lg space-y-3 rounded-2xl border border-[var(--bark-700)] bg-[var(--bark-800)] p-8" role="status">
        <p className="text-sm font-semibold">Your instance is moving to {move.data?.machine ?? 'your machine'}</p>
        <p className="text-xs text-slate-400">{move.data?.detail ?? 'Copying everything in it.'} It opens there once the move is done, at this same address.</p>
      </div>
    </div>
  )
}
