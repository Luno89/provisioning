import { useState } from 'react'
import { AlertTriangle, Check, Copy, HardDrive, Loader2, Plus, X } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { useCreateMyJoinCode, useDismissMachineJoin, useMyMachines, useMyMachinesLive, usePutKoalaOn, type MachineJoinView } from '../api'
import { joinStatus } from '../lib/machine-joins'
import { installShown, type InstallShown } from '../lib/koala-install'

function JoinRow({ join, onDismiss, dismissing }: { join: MachineJoinView; onDismiss: (id: string) => void; dismissing: boolean }) {
  const status = joinStatus(join, new Date())
  const dismiss = (
    <button type="button" onClick={() => onDismiss(join.id)} disabled={dismissing} aria-label="Dismiss" className="text-slate-400 hover:text-slate-100 disabled:opacity-50">
      <X size={14} />
    </button>
  )
  if (status === 'joining') {
    return (
      <li className="flex items-center justify-between gap-2 rounded-md border border-[var(--bark-700)] px-3 py-2 text-xs text-slate-200">
        <span className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-slate-400" />
          <span className="text-slate-400">{join.state === 'started' ? 'Joining:' : 'Joining, finished:'}</span>
          <span>{join.title}</span>
          {join.joined && <span className="text-[10px] text-slate-500">last heard {new Date(join.at).toLocaleTimeString()}</span>}
        </span>
        {join.joined && dismiss}
      </li>
    )
  }
  if (status === 'stopped') {
    return (
      <li className="flex items-start justify-between gap-2 rounded-md border border-[var(--bark-700)] px-3 py-2 text-xs text-slate-300">
        <span>A machine stopped reporting at <span className="text-slate-100">{join.title}</span>: its command expired before it finished joining. Make a new command and run it there.</span>
        {dismiss}
      </li>
    )
  }
  return (
    <li role="alert" className="flex items-start justify-between gap-2 rounded-md border border-rose-800 px-3 py-2 text-xs text-rose-200">
      <span className="space-y-1">
        <span className="flex items-center gap-2"><AlertTriangle size={14} /> A machine could not join at <span className="font-medium">{join.title}</span></span>
        <span className="block whitespace-pre-wrap font-mono text-[11px] text-rose-100">{join.why}</span>
        <span className="block text-[11px] text-slate-400">Fix that, then run the command again on that machine.</span>
      </span>
      {dismiss}
    </li>
  )
}

function InstallLine({ shown, retrying, onRetry }: { shown: InstallShown | undefined; retrying: boolean; onRetry: () => void }) {
  if (!shown) return null
  if (shown.kind === 'working') {
    return (
      <p className="flex items-start gap-2 text-[11px] text-slate-300">
        <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-slate-400" />
        <span className="space-y-0.5">
          <span className="block">{shown.title}</span>
          {shown.line && <span className="block font-mono text-[10px] text-slate-400">{shown.line}</span>}
        </span>
      </p>
    )
  }
  return (
    <div role="alert" className="space-y-1 rounded-md border border-rose-800 px-2 py-1.5 text-[11px] text-rose-200">
      <p className="flex items-center gap-2"><AlertTriangle size={12} /> {shown.said}</p>
      <p className="whitespace-pre-wrap font-mono text-[10px] text-rose-100">{shown.why}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="rounded border border-rose-700/60 px-1.5 py-0.5 text-[10px] text-rose-100 disabled:opacity-50"
      >
        {shown.retry}
      </button>
    </div>
  )
}

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
  const dismissJoin = useDismissMachineJoin()
  useMyMachinesLive()
  const machines = mine.data?.machines ?? []
  const joins = mine.data?.joins ?? []
  const install = mine.data?.koala?.install

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
      {joins.length > 0 && (
        <ul className="space-y-2">
          {joins.map((join) => <JoinRow key={join.id} join={join} onDismiss={(id) => dismissJoin.mutate(id)} dismissing={dismissJoin.isPending} />)}
        </ul>
      )}
      {machines.length > 0 && (
        <ul className="space-y-2">
          {machines.map((machine) => {
            const shown = installShown(install, machine)
            return (
            <li key={machine.id} className="space-y-1 rounded-md border border-[var(--bark-700)] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs text-slate-200">
                <HardDrive size={14} />
                {machine.name}
                <span className={`h-2 w-2 rounded-full ${machine.online ? 'bg-emerald-400' : 'bg-slate-600'}`} aria-label={machine.online ? 'online' : 'offline'} />
                {machine.holdsKoala && <span className="text-[11px] text-emerald-300">holds your Koala</span>}
              </span>
              {!machine.holdsKoala && !hasKoala && shown?.kind !== 'failed' && (
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
              </div>
              <InstallLine
                shown={shown}
                retrying={place.isPending || !nameOk}
                onRetry={() => place.mutate({ machineId: machine.id, name }, { onSuccess: onPlacing })}
              />
              {machine.koalaRefused && !hasKoala && (
                <p className="flex items-center gap-2 text-[11px] text-amber-300">
                  <span>Koala could not be put here: {machine.koalaRefused.reason}</span>
                  <button
                    type="button"
                    onClick={() => place.mutate({ machineId: machine.id, name }, { onSuccess: onPlacing })}
                    disabled={place.isPending || !nameOk}
                    className="rounded border border-amber-700/60 px-1.5 py-0.5 text-[10px] text-amber-200 disabled:opacity-50"
                  >
                    Try again
                  </button>
                </p>
              )}
              {machine.keyReplacement && (
                <p className="text-[11px] text-amber-300">
                  {`Its key could not be replaced: ${machine.keyReplacement.reason}; it stops working on ${new Date(machine.keyReplacement.stopsAt).toLocaleDateString()} unless it is`}
                </p>
              )}
            </li>
            )
          })}
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
      {(createCode.isError || place.isError || dismissJoin.isError) && <p role="alert" className="text-xs text-rose-300">{errorMessage(createCode.error ?? place.error ?? dismissJoin.error)}</p>}
    </div>
  )
}
