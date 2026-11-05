import { useState } from 'react'
import { Check, Copy, HardDrive, Loader2, Plus } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { useCreateMyJoinCode, useMyMachines, usePutKoalaOn } from '../api'

export interface AccountMachinesProps {
  name: string
  nameOk: boolean
  hasKoala: boolean
  onPlacing: () => void
}

export default function AccountMachines({ name, nameOk, hasKoala, onPlacing }: AccountMachinesProps) {
  const [adding, setAdding] = useState(false)
  const [putHere, setPutHere] = useState(!hasKoala)
  const [copied, setCopied] = useState(false)
  const createCode = useCreateMyJoinCode()
  const mine = useMyMachines(adding || Boolean(createCode.data))
  const place = usePutKoalaOn()
  const machines = mine.data?.machines ?? []

  const add = () => {
    setAdding(true)
    createCode.mutate(putHere && nameOk ? name : undefined, { onSuccess: () => { if (putHere) onPlacing() } })
  }
  const copy = async () => {
    if (!createCode.data) return
    await navigator.clipboard.writeText(createCode.data.command)
    setCopied(true)
  }

  return (
    <div className="space-y-3" data-testid="account-machines">
      {machines.length > 0 && (
        <ul className="space-y-2">
          {machines.map((machine) => (
            <li key={machine.id} className="flex items-center justify-between gap-2 rounded-md border border-[var(--bark-700)] px-3 py-2">
              <span className="flex items-center gap-2 text-xs text-slate-200">
                <HardDrive size={14} />
                {machine.name}
                <span className={`h-2 w-2 rounded-full ${machine.online ? 'bg-emerald-400' : 'bg-slate-600'}`} aria-label={machine.online ? 'online' : 'offline'} />
                {machine.holdsKoala && <span className="text-[11px] text-emerald-300">holds your Koala</span>}
              </span>
              {!machine.holdsKoala && !hasKoala && (
                <button
                  type="button"
                  onClick={() => place.mutate({ machineId: machine.id, name }, { onSuccess: onPlacing })}
                  disabled={place.isPending || !nameOk || !machine.meshIp}
                  title={machine.meshIp ? undefined : 'It is not on your private network yet'}
                  className="rounded-md bg-[var(--leaf-stem)] px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  {place.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Put Koala here'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!createCode.data ? (
        <div className="space-y-2">
          {!hasKoala && (
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={putHere} onChange={(event) => setPutHere(event.target.checked)} />
              Put my Koala on this machine
            </label>
          )}
          <button
            type="button"
            onClick={add}
            disabled={createCode.isPending || (putHere && !hasKoala && !nameOk)}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--bark-700)] px-3 py-1.5 text-xs font-medium text-slate-200 disabled:opacity-50"
          >
            {createCode.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add a machine
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-slate-300">On that machine, run this as yourself. It asks which folder Koala may work in and asks before installing anything.</p>
          <div className="flex items-start gap-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] p-2">
            <code className="flex-1 break-all font-mono text-[11px] text-emerald-200">{createCode.data.command}</code>
            <button type="button" onClick={() => void copy()} aria-label="Copy the command" className="text-slate-400 hover:text-slate-100">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <p className="text-[10px] text-slate-500">The command works once, until {new Date(createCode.data.expiresAt).toLocaleTimeString()}.</p>
        </div>
      )}
      {(createCode.isError || place.isError) && <p role="alert" className="text-xs text-rose-300">{errorMessage(createCode.error ?? place.error)}</p>}
    </div>
  )
}
