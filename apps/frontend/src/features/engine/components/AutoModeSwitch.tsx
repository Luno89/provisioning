import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import type { AutoModeState } from '../hooks/useAutoMode'

export default function AutoModeSwitch({ state, label, explain }: { state: AutoModeState; label: string; explain: string }) {
  return (
    <div className="flex flex-col gap-1" data-testid="auto-mode">
      <label className="flex items-center gap-2 text-[12px] text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          aria-label={label}
          checked={state.on === true}
          disabled={state.on === undefined || state.switching}
          onChange={(event) => state.turn(event.target.checked)}
          className="accent-amber-400"
        />
        {label}
        {state.switching && <Loader2 size={11} className="animate-spin text-slate-400" />}
      </label>
      <span className="text-[11px] text-slate-500">{explain}</span>
      {state.error ? <span className="text-[11px] text-rose-300">{errorMessage(state.error)}</span> : null}
    </div>
  )
}
