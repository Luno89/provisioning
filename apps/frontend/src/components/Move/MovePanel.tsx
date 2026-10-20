import { useState } from 'react'
import { Check, Copy, Loader2, Truck } from 'lucide-react'
import { errorMessage } from '../../api/client'
import type { MoveCommand, MoveView } from '../../api/instances'

export interface MovePanelProps {
  move: MoveView | null | undefined
  command: MoveCommand | undefined
  starting: boolean
  stopping: boolean
  error: unknown
  onStart: () => void
  onStop: () => void
}

const UNDER_WAY: Record<MoveView['state'], string> = {
  waiting: 'Waiting for your machine',
  joined: 'Your machine is setting itself up',
  copying: 'Copying your instance to your machine',
  switching: 'Switching your address to your machine',
  failed: 'The move stopped',
}

export function MovePanel({ move, command, starting, stopping, error, onStart, onStop }: MovePanelProps) {
  const [copied, setCopied] = useState(false)
  const active = move && move.state !== 'failed'
  const copy = async () => {
    if (!command) return
    await navigator.clipboard.writeText(command.command)
    setCopied(true)
  }
  return (
    <div className="space-y-3" data-testid="move-panel">
      <p className="text-xs text-slate-400">
        Your instance moves to a Linux machine of your own with everything in it: chats, projects, repositories, secrets and settings.
        While it copies, this instance stops taking work. Nothing here is deleted until your machine runs it.
      </p>
      {move && (
        <div className={`rounded-xl border px-3 py-2 text-xs ${move.state === 'failed' ? 'border-rose-500/30 text-rose-200' : 'border-sky-500/30 text-sky-100'}`} role="status">
          <div className="flex items-center gap-2 font-semibold">
            {active && <Loader2 size={12} className="animate-spin" />}
            {UNDER_WAY[move.state]}{move.machine ? ` (${move.machine})` : ''}
          </div>
          {move.detail && <div className="mt-0.5 text-slate-300">{move.detail}</div>}
        </div>
      )}
      {command && active && (
        <div className="space-y-1">
          <p className="text-xs text-slate-300">Run this on your machine, as root:</p>
          <div className="flex items-start gap-2">
            <code className="flex-1 break-all rounded-lg bg-slate-900/70 px-3 py-2 text-[11px] text-slate-100">{command.command}</code>
            <button type="button" onClick={() => { void copy() }} aria-label="Copy the move command" className="mt-1 text-slate-400 hover:text-slate-100">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <p className="text-[11px] text-slate-500">It works once, for an hour.</p>
        </div>
      )}
      <div className="flex items-center gap-2">
        {(!active || !command) && move?.state !== 'switching' && (
          <button type="button" onClick={onStart} disabled={starting} className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50">
            {starting ? <Loader2 size={12} className="animate-spin" /> : <Truck size={12} />}
            {active ? 'Show the move command again' : 'Move to my own machine'}
          </button>
        )}
        {active && move.state !== 'switching' && (
          <button type="button" onClick={onStop} disabled={stopping} className="rounded-xl bg-slate-700 px-3 py-2 text-xs font-bold text-white hover:bg-slate-600 disabled:opacity-50">
            Stop the move
          </button>
        )}
      </div>
      {Boolean(error) && <p role="alert" className="text-xs text-rose-300">{errorMessage(error)}</p>}
    </div>
  )
}
